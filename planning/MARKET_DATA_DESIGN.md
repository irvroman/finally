# FinAlly Market Data Backend Design

Implementation guide for the market data subsystem in `backend/app/market/`. The design presents one source-agnostic API with two providers:

- `SimulatorDataSource`: a local GBM-based emulator used by default.
- `MassiveDataSource`: a REST poller for real stock snapshots when `MASSIVE_API_KEY` is configured.

Both providers write to the same `PriceCache`. SSE, portfolio valuation, trade execution, and watchlist code read from that cache and do not need to know which provider is active.

## 1. Goals and Non-goals

### Goals

- Make simulator and real market data interchangeable.
- Keep all downstream consumers independent of provider timing and SDK details.
- Provide an immediate price for every tracked ticker at startup or when it is added.
- Support dynamic watchlist changes without restarting the process.
- Avoid blocking FastAPI's event loop during synchronous API calls.
- Make the SSE payload stable and easy for the frontend to consume.
- Keep simulator-only development free of external service credentials.
- Make provider failures observable and recoverable without crashing the backend.

### Non-goals

- Order books, limit orders, bid/ask execution, or partial fills.
- Historical data storage. The cache intentionally stores only the latest update.
- WebSocket market data. The first production integration uses REST polling.
- Multi-user isolation in the market layer. The current application has one logical user.

## 2. Runtime Architecture

```text
                    +----------------------+
                    | FastAPI application  |
                    | lifespan             |
                    +----------+-----------+
                               |
                 create_market_data_source()
                               |
             +-----------------+-----------------+
             |                                   |
     SimulatorDataSource                 MassiveDataSource
       GBMSimulator                 synchronous RESTClient in thread
             |                                   |
             +-----------------+-----------------+
                               |
                        PriceCache
                    (latest update/ticker)
                               |
       +-------------------+---+-------------------+
       |                   |                       |
  SSE price stream   portfolio valuation      trade execution
```

The provider is a producer. It owns its polling or simulation loop and writes updates into the cache. Consumers never call provider-specific methods to retrieve prices.

## 3. Module Layout

```text
backend/
  app/
    market/
      __init__.py       # Public re-exports
      models.py         # PriceUpdate value object
      cache.py          # Thread-safe latest-price store
      interface.py      # MarketDataSource abstract contract
      seed_prices.py    # Simulator seeds and parameters
      simulator.py      # GBMSimulator and SimulatorDataSource
      massive_client.py # MassiveDataSource
      factory.py        # Environment-based provider selection
      stream.py         # FastAPI SSE router
  tests/
    market/
      test_models.py
      test_cache.py
      test_factory.py
      test_massive.py
      test_simulator.py
      test_simulator_source.py
```

The backend already declares `massive` and `numpy` as dependencies in `backend/pyproject.toml`. A simulator-only deployment still needs no API key; the provider selection is controlled by the environment.

## 4. Shared Data Contract

### 4.1 `PriceUpdate`

`PriceUpdate` is the only price structure that crosses the market-data boundary. It is immutable so a consumer cannot mutate the snapshot another consumer is reading.

```python
# backend/app/market/models.py
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class PriceUpdate:
    ticker: str
    price: float
    previous_price: float
    timestamp: float = field(default_factory=time.time)

    @property
    def change(self) -> float:
        return round(self.price - self.previous_price, 4)

    @property
    def change_percent(self) -> float:
        if self.previous_price == 0:
            return 0.0
        return round(
            (self.price - self.previous_price) / self.previous_price * 100,
            4,
        )

    @property
    def direction(self) -> str:
        if self.price > self.previous_price:
            return "up"
        if self.price < self.previous_price:
            return "down"
        return "flat"

    def to_dict(self) -> dict[str, object]:
        return {
            "ticker": self.ticker,
            "price": self.price,
            "previous_price": self.previous_price,
            "timestamp": self.timestamp,
            "change": self.change,
            "change_percent": self.change_percent,
            "direction": self.direction,
        }
```

The timestamp is Unix seconds. The simulator uses the local clock. Massive timestamps are Unix milliseconds and must be divided by `1000.0` before entering the cache.

### 4.2 Ticker normalization

Ticker symbols are uppercase and whitespace-free at provider boundaries. The watchlist API should normalize and validate before updating its database. Providers should normalize again because they are also called by AI actions and tests.

```python
def normalize_ticker(ticker: str) -> str:
    normalized = ticker.upper().strip()
    if not normalized or len(normalized) > 12:
        raise ValueError("Ticker must be a non-empty symbol")
    return normalized
```

The existing provider methods apply `upper().strip()` when adding or removing Massive tickers. Keep normalization centralized in the watchlist validation layer as the API grows.

## 5. Price Cache

### 5.1 Responsibilities

`PriceCache` is the single point of truth for the latest price of each active ticker. It:

- Computes `previous_price` from the prior cached update.
- Rounds prices to cents at the storage boundary.
- Provides immutable snapshots to readers.
- Removes data when a ticker is no longer tracked.
- Maintains a monotonically increasing version for efficient SSE change detection.
- Uses `threading.Lock` because Massive REST calls run in worker threads.

```python
# backend/app/market/cache.py
from __future__ import annotations

import time
from threading import Lock

from .models import PriceUpdate


class PriceCache:
    def __init__(self) -> None:
        self._prices: dict[str, PriceUpdate] = {}
        self._lock = Lock()
        self._version = 0

    def update(
        self,
        ticker: str,
        price: float,
        timestamp: float | None = None,
    ) -> PriceUpdate:
        with self._lock:
            previous = self._prices.get(ticker)
            previous_price = previous.price if previous else price
            update = PriceUpdate(
                ticker=ticker,
                price=round(price, 2),
                previous_price=round(previous_price, 2),
                timestamp=timestamp or time.time(),
            )
            self._prices[ticker] = update
            self._version += 1
            return update

    def get(self, ticker: str) -> PriceUpdate | None:
        with self._lock:
            return self._prices.get(ticker)

    def get_price(self, ticker: str) -> float | None:
        update = self.get(ticker)
        return update.price if update else None

    def get_all(self) -> dict[str, PriceUpdate]:
        with self._lock:
            return dict(self._prices)

    def remove(self, ticker: str) -> None:
        with self._lock:
            self._prices.pop(ticker, None)

    @property
    def version(self) -> int:
        with self._lock:
            return self._version
```

`get_all()` returns a shallow copy of the mapping. The `PriceUpdate` values are frozen, so readers can safely serialize them after releasing the lock.

### 5.2 Cache semantics

The first update for a ticker has `previous_price == price`, `change == 0`, and `direction == "flat"`. Removing and re-adding a ticker intentionally starts a new price history for that ticker in the cache.

A cache update represents a new provider observation, even if the rounded price is unchanged. The version increments in that case so a provider heartbeat can still be delivered when desired. The SSE implementation currently emits only when the version changes.

## 6. Unified Provider Interface

The interface controls lifecycle and the active ticker set. It deliberately does not expose a `get_price()` method; current prices belong to `PriceCache`.

```python
# backend/app/market/interface.py
from __future__ import annotations

from abc import ABC, abstractmethod


class MarketDataSource(ABC):
    @abstractmethod
    async def start(self, tickers: list[str]) -> None:
        """Initialize state, seed/poll prices, and start the producer loop."""

    @abstractmethod
    async def stop(self) -> None:
        """Cancel the producer loop and release provider resources."""

    @abstractmethod
    async def add_ticker(self, ticker: str) -> None:
        """Begin tracking a ticker; repeated calls are no-ops."""

    @abstractmethod
    async def remove_ticker(self, ticker: str) -> None:
        """Stop tracking a ticker and remove its cached price."""

    @abstractmethod
    def get_tickers(self) -> list[str]:
        """Return a snapshot of currently tracked tickers."""
```

### Lifecycle rules

1. Construct the source through the factory.
2. Call `start()` once during application startup.
3. Use `add_ticker()` and `remove_ticker()` for runtime changes.
4. Call `stop()` during application shutdown.
5. `stop()` must be safe when called after a failed start or more than once.

Each implementation owns one `asyncio.Task`. The task must be cancelled and awaited so it cannot continue writing after shutdown.

## 7. Simulator / Emulator

### 7.1 Seed data

The simulator starts the default watchlist at realistic prices and assigns per-ticker annualized drift (`mu`) and volatility (`sigma`). Unknown tickers use a random seed between `$50` and `$300` and the default parameters.

```python
# backend/app/market/seed_prices.py
SEED_PRICES = {
    "AAPL": 190.0,
    "GOOGL": 175.0,
    "MSFT": 420.0,
    "AMZN": 185.0,
    "TSLA": 250.0,
    "NVDA": 800.0,
    "META": 500.0,
    "JPM": 195.0,
    "V": 280.0,
    "NFLX": 600.0,
}

TICKER_PARAMS = {
    "AAPL": {"sigma": 0.22, "mu": 0.05},
    "GOOGL": {"sigma": 0.25, "mu": 0.05},
    "MSFT": {"sigma": 0.20, "mu": 0.05},
    "AMZN": {"sigma": 0.28, "mu": 0.05},
    "TSLA": {"sigma": 0.50, "mu": 0.03},
    "NVDA": {"sigma": 0.40, "mu": 0.08},
    "META": {"sigma": 0.30, "mu": 0.05},
    "JPM": {"sigma": 0.18, "mu": 0.04},
    "V": {"sigma": 0.17, "mu": 0.04},
    "NFLX": {"sigma": 0.35, "mu": 0.05},
}

DEFAULT_PARAMS = {"sigma": 0.25, "mu": 0.05}
```

### 7.2 GBM equation

For each ticker and time step:

$$
S_{t+dt} = S_t \exp\left((\mu - \frac{1}{2}\sigma^2)dt + \sigma\sqrt{dt}Z\right)
$$

where `S` is price, `mu` is annualized drift, `sigma` is annualized volatility, and `Z` is a standard normal random value. Prices remain positive because the update is multiplicative.

A 500 ms update uses a trading-year denominator of:

```python
TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600
DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR
```

### 7.3 Correlated moves

To make related tickers move together, construct a correlation matrix and calculate its Cholesky factor `L`. Generate independent normal values `z` and transform them:

```python
z_correlated = cholesky @ z_independent
```

The current correlation policy is:

- Same technology group: `0.6`.
- Same finance group: `0.5`.
- TSLA with any ticker: `0.3`.
- Cross-sector and unknown pairs: `0.3`.

Rebuild the matrix after adding or removing a ticker. The active set is small, so the `O(n^2)` rebuild is acceptable.

### 7.4 Simulator math engine

```python
# backend/app/market/simulator.py
import math
import random

import numpy as np


class GBMSimulator:
    TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600
    DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR

    def __init__(
        self,
        tickers: list[str],
        dt: float = DEFAULT_DT,
        event_probability: float = 0.001,
    ) -> None:
        self._dt = dt
        self._event_probability = event_probability
        self._tickers: list[str] = []
        self._prices: dict[str, float] = {}
        self._params: dict[str, dict[str, float]] = {}
        self._cholesky: np.ndarray | None = None

        for ticker in tickers:
            self._add_ticker_internal(ticker)
        self._rebuild_cholesky()

    def step(self) -> dict[str, float]:
        if not self._tickers:
            return {}

        independent = np.random.standard_normal(len(self._tickers))
        correlated = (
            self._cholesky @ independent
            if self._cholesky is not None
            else independent
        )

        result: dict[str, float] = {}
        for index, ticker in enumerate(self._tickers):
            params = self._params[ticker]
            drift = (params["mu"] - 0.5 * params["sigma"] ** 2) * self._dt
            diffusion = params["sigma"] * math.sqrt(self._dt) * correlated[index]
            self._prices[ticker] *= math.exp(drift + diffusion)

            if random.random() < self._event_probability:
                magnitude = random.uniform(0.02, 0.05)
                self._prices[ticker] *= 1 + magnitude * random.choice([-1, 1])

            result[ticker] = round(self._prices[ticker], 2)
        return result
```

The random event is intentionally rare and produces a 2-5% positive or negative move. It creates visible dashboard activity without replacing the normal GBM path.

### 7.5 Async simulator provider

The wrapper seeds the cache before starting its task. That makes the first SSE response useful immediately.

```python
class SimulatorDataSource(MarketDataSource):
    def __init__(self, price_cache: PriceCache, update_interval: float = 0.5):
        self._cache = price_cache
        self._interval = update_interval
        self._sim: GBMSimulator | None = None
        self._task: asyncio.Task | None = None

    async def start(self, tickers: list[str]) -> None:
        self._sim = GBMSimulator(tickers)
        for ticker in self._sim.get_tickers():
            price = self._sim.get_price(ticker)
            if price is not None:
                self._cache.update(ticker, price)
        self._task = asyncio.create_task(self._run_loop(), name="simulator-loop")

    async def _run_loop(self) -> None:
        while True:
            try:
                if self._sim is not None:
                    for ticker, price in self._sim.step().items():
                        self._cache.update(ticker, price)
            except Exception:
                logger.exception("Simulator step failed")
            await asyncio.sleep(self._interval)
```

`add_ticker()` calls `GBMSimulator.add_ticker()` and immediately writes its seed price. `remove_ticker()` removes it from the simulator and cache. `stop()` cancels and awaits the task, swallowing `asyncio.CancelledError` after cleanup.

## 8. Massive API Provider

### 8.1 API choice

Use one all-tickers snapshot request per poll. The official Python client is `massive-com/client-python` and the relevant call is:

```python
from massive import RESTClient
from massive.rest.models import SnapshotMarketType

client = RESTClient(api_key=api_key)
snapshots = client.get_snapshot_all(
    market_type=SnapshotMarketType.STOCKS,
    tickers=["AAPL", "GOOGL", "MSFT"],
)
```

Each returned ticker snapshot can contain `last_trade`, `last_quote`, `day`, `prev_day`, and other fields. FinAlly needs `snapshot.ticker`, `snapshot.last_trade.price`, and `snapshot.last_trade.timestamp` for the live cache. If a snapshot lacks a valid last trade, skip that ticker and retain its last known cached price.

The all-tickers request is important for the free tier because it keeps a watchlist poll to one API request. Use a 15-second default interval for the documented five-requests-per-minute tier; allow a shorter interval only when the account supports it.

### 8.2 Provider implementation

```python
# backend/app/market/massive_client.py
from __future__ import annotations

import asyncio
import logging

from massive import RESTClient
from massive.rest.models import SnapshotMarketType

from .cache import PriceCache
from .interface import MarketDataSource

logger = logging.getLogger(__name__)


class MassiveDataSource(MarketDataSource):
    def __init__(
        self,
        api_key: str,
        price_cache: PriceCache,
        poll_interval: float = 15.0,
    ) -> None:
        self._api_key = api_key
        self._cache = price_cache
        self._interval = poll_interval
        self._tickers: list[str] = []
        self._client: RESTClient | None = None
        self._task: asyncio.Task | None = None

    async def start(self, tickers: list[str]) -> None:
        self._client = RESTClient(api_key=self._api_key)
        self._tickers = [ticker.upper().strip() for ticker in tickers]
        await self._poll_once()  # Populate cache before serving requests.
        self._task = asyncio.create_task(self._poll_loop(), name="massive-poller")

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            await self._poll_once()

    async def _poll_once(self) -> None:
        if not self._tickers or self._client is None:
            return

        try:
            snapshots = await asyncio.to_thread(self._fetch_snapshots)
            for snapshot in snapshots:
                try:
                    last_trade = snapshot.last_trade
                    self._cache.update(
                        ticker=snapshot.ticker,
                        price=last_trade.price,
                        timestamp=last_trade.timestamp / 1000.0,
                    )
                except (AttributeError, TypeError):
                    logger.warning(
                        "Skipping malformed snapshot for %s",
                        getattr(snapshot, "ticker", "unknown"),
                    )
        except Exception:
            logger.exception("Massive poll failed; retrying next interval")

    def _fetch_snapshots(self) -> list:
        assert self._client is not None
        return self._client.get_snapshot_all(
            market_type=SnapshotMarketType.STOCKS,
            tickers=self._tickers,
        )
```

The synchronous SDK call runs in `asyncio.to_thread()` so DNS, network latency, and SDK processing cannot block SSE or REST requests. The current implementation catches provider exceptions, logs them, and keeps the task alive for the next poll.

### 8.3 Runtime ticker changes

```python
async def add_ticker(self, ticker: str) -> None:
    ticker = ticker.upper().strip()
    if ticker not in self._tickers:
        self._tickers.append(ticker)
        # It will be populated on the next all-tickers poll.


async def remove_ticker(self, ticker: str) -> None:
    ticker = ticker.upper().strip()
    self._tickers = [item for item in self._tickers if item != ticker]
    self._cache.remove(ticker)
```

Adding a Massive ticker does not perform a second immediate request. This avoids a burst of one-ticker calls; the next scheduled all-tickers poll includes it.

### 8.4 Failure behavior

| Condition | Behavior |
|---|---|
| Invalid API key / HTTP 401 | Log the poll failure; retain last known prices; retry next interval. |
| Rate limit / HTTP 429 | Log the failure; wait the configured interval; retry. |
| Network or SDK error | Log the exception; do not kill the background task. |
| One malformed ticker snapshot | Warn and skip that ticker only. |
| Empty snapshot response | Keep existing cache values. |
| Market closed | Use the latest returned trade; do not invent a price. |

A future production version may add a provider health state and exponential backoff. The current single-user demo should keep the behavior predictable and preserve last-known prices.

## 9. Provider Factory and Configuration

The factory returns an unstarted source. An empty or whitespace-only key selects the simulator; a non-empty key selects Massive.

```python
# backend/app/market/factory.py
import logging
import os

from .cache import PriceCache
from .interface import MarketDataSource
from .massive_client import MassiveDataSource
from .simulator import SimulatorDataSource

logger = logging.getLogger(__name__)


def create_market_data_source(price_cache: PriceCache) -> MarketDataSource:
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()
    if api_key:
        logger.info("Market data source: Massive API")
        return MassiveDataSource(api_key=api_key, price_cache=price_cache)

    logger.info("Market data source: GBM simulator")
    return SimulatorDataSource(price_cache=price_cache)
```

Configuration examples:

```bash
# Simulator mode, recommended for local development and tests
MASSIVE_API_KEY=

# Real snapshot polling
MASSIVE_API_KEY=your-massive-key
```

Do not put API keys in source control. Keep `.env` ignored and commit only an `.env.example` with an empty placeholder.

## 10. SSE Stream

The stream endpoint is the transport boundary for the frontend. It sends a retry directive first, then sends a JSON object keyed by ticker whenever the cache version changes.

```python
# backend/app/market/stream.py
async def _generate_events(
    price_cache: PriceCache,
    request: Request,
    interval: float = 0.5,
) -> AsyncGenerator[str, None]:
    yield "retry: 1000\n\n"
    last_version = -1

    try:
        while True:
            if await request.is_disconnected():
                break

            if price_cache.version != last_version:
                last_version = price_cache.version
                prices = price_cache.get_all()
                if prices:
                    payload = json.dumps({
                        ticker: update.to_dict()
                        for ticker, update in prices.items()
                    })
                    yield f"data: {payload}\n\n"

            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("SSE stream cancelled")
```

Route configuration:

```python
router = APIRouter(prefix="/api/stream", tags=["streaming"])

@router.get("/prices")
async def stream_prices(request: Request) -> StreamingResponse:
    return StreamingResponse(
        _generate_events(price_cache, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
```

Example event:

```text
data: {"AAPL":{"ticker":"AAPL","price":190.12,"previous_price":190.08,"timestamp":1707580800.5,"change":0.04,"change_percent":0.021,"direction":"up"}}

```

Frontend consumption is provider-independent:

```javascript
const events = new EventSource("/api/stream/prices");

events.onmessage = (event) => {
  const pricesByTicker = JSON.parse(event.data);
  // pricesByTicker.AAPL.price, .direction, and .change_percent
};

events.onerror = () => {
  // EventSource automatically retries using retry: 1000.
};
```

The version check matters for Massive mode: a 15-second poller should not cause the server to serialize the same payload every 500 ms.

## 11. FastAPI Lifecycle Integration

Create one cache and one provider for the process. Start the provider after loading the initial watchlist and stop it during lifespan teardown.

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI


@asynccontextmanager
async def lifespan(app: FastAPI):
    cache = PriceCache()
    source = create_market_data_source(cache)
    app.state.price_cache = cache
    app.state.market_source = source

    initial_tickers = await load_watchlist_tickers()
    await source.start(initial_tickers)
    try:
        yield
    finally:
        await source.stop()


app = FastAPI(title="FinAlly", lifespan=lifespan)
```

Use dependency functions so portfolio and watchlist routes receive the application-owned instances:

```python
def get_price_cache() -> PriceCache:
    return app.state.price_cache


def get_market_source() -> MarketDataSource:
    return app.state.market_source
```

Startup ordering is intentional:

1. Initialize database and load the watchlist.
2. Create the cache and provider.
3. Start the provider. The simulator seeds immediately; Massive performs its first poll.
4. Register or expose the stream route.
5. Serve requests only after initial prices are available when the provider can supply them.

## 12. Watchlist and Portfolio Coordination

### Add flow

```python
@router.post("/watchlist")
async def add_ticker(
    payload: WatchlistAdd,
    source: MarketDataSource = Depends(get_market_source),
):
    ticker = normalize_ticker(payload.ticker)
    await db.insert_watchlist(ticker)
    await source.add_ticker(ticker)
    return {"ticker": ticker, "price": price_cache.get_price(ticker)}
```

The simulator returns a price immediately because it seeds the cache. Massive returns `None` until the next poll; the API should communicate that explicitly or return the last known price if one exists.

### Remove flow

A ticker with an open position must remain tracked even if it is removed from the visible watchlist. Otherwise portfolio valuation becomes stale.

```python
@router.delete("/watchlist/{ticker}")
async def remove_ticker(
    ticker: str,
    source: MarketDataSource = Depends(get_market_source),
):
    ticker = normalize_ticker(ticker)
    await db.delete_watchlist(ticker)

    position = await db.get_position(ticker)
    if position is None or position.quantity == 0:
        await source.remove_ticker(ticker)

    return {"status": "ok", "ticker": ticker}
```

The initial provider ticker set should be the union of watchlist tickers and tickers with open positions. AI-created watchlist changes must use the same route/service so database state and provider state cannot diverge.

### Trade flow

A market order reads the current cached price and never calls Massive or the simulator directly:

```python
current_price = price_cache.get_price(order.ticker)
if current_price is None:
    raise HTTPException(404, "No current price is available")

# Buy: verify cash, then update position and append trade.
# Sell: verify quantity, then update position and append trade.
# Record a portfolio snapshot after the transaction.
```

This gives manual trades and AI-executed trades the same pricing and validation behavior.

## 13. Testing Plan

The market layer should be testable without a running FastAPI server or a real API key.

### Models and cache

```python
def test_first_update_is_flat():
    cache = PriceCache()
    update = cache.update("AAPL", 190.123)
    assert update.price == 190.12
    assert update.previous_price == 190.12
    assert update.direction == "flat"


def test_second_update_computes_change():
    cache = PriceCache()
    cache.update("AAPL", 190.00)
    update = cache.update("AAPL", 191.00)
    assert update.change == 1.0
    assert update.direction == "up"
```

Also test missing tickers, removal, copies returned by `get_all()`, zero previous prices, and version increments.

### Simulator

Required assertions:

- Empty simulator returns `{}`.
- Seed prices match known symbols.
- Unknown symbols are seeded in the configured range.
- Every stepped price is positive.
- `step()` returns every active ticker.
- Add and remove rebuild the correlation matrix.
- Duplicate add and missing remove are no-ops.
- A forced event changes the price path when randomness is patched.
- The ten-symbol default watchlist builds a valid Cholesky matrix.

For deterministic tests, inject or patch NumPy/random sources rather than asserting an exact random price.

### Provider integration

Use a short update interval in tests and cancel providers in `finally` blocks:

```python
@pytest.mark.asyncio
async def test_simulator_seeds_cache():
    cache = PriceCache()
    source = SimulatorDataSource(cache, update_interval=0.001)
    await source.start(["AAPL"])
    try:
        assert cache.get_price("AAPL") == 190.0
    finally:
        await source.stop()
```

### Massive without network calls

Mock `_fetch_snapshots()` or the client method. Verify:

- `start()` performs an immediate poll.
- The client receives `SnapshotMarketType.STOCKS` and the complete ticker list.
- Snapshot milliseconds become Unix seconds.
- A malformed snapshot is skipped without losing other symbols.
- API exceptions do not escape `_poll_once()`.
- Add/remove normalizes tickers and updates the cache correctly.
- `stop()` cancels the poll task and clears the client.

Do not use a real Massive key in unit or CI tests.

### SSE

Test the generator with a fake request:

1. First yield is `retry: 1000`.
2. A populated cache produces valid `data:` JSON.
3. The payload includes `direction`, `change_percent`, and timestamps.
4. No duplicate payload is emitted while the cache version is unchanged.
5. A disconnected request ends the generator.
6. Cancellation does not raise to the caller.

An ASGI integration test should additionally check `content-type: text/event-stream` and the no-buffering headers.

### Commands

```powershell
cd backend
uv run pytest
uv run pytest --cov=app --cov-report=term-missing
uv run ruff check app tests
```

## 14. Observability and Operations

Log provider selection once at startup. Log provider lifecycle transitions at `INFO`, poll failures at `ERROR`, malformed individual snapshots at `WARNING`, and successful poll counts at `DEBUG`.

Useful health data for a future `/api/health` response:

```json
{
  "market_source": "simulator",
  "tracked_tickers": 10,
  "cached_tickers": 10,
  "last_update": "2026-09-22T12:00:00Z",
  "provider_error": null
}
```

The current cache has bounded memory: it stores one update per ticker. Do not add unbounded price history to it. Sparkline history belongs in the frontend or in a separate bounded structure.

## 15. Implementation Checklist

- [x] Define immutable `PriceUpdate` and one serialization method.
- [x] Implement lock-protected latest-price cache and version counter.
- [x] Define the provider lifecycle interface.
- [x] Implement GBM with per-ticker parameters and correlated moves.
- [x] Seed simulator prices immediately.
- [x] Implement Massive all-tickers snapshot polling through `asyncio.to_thread()`.
- [x] Convert Massive timestamps from milliseconds to seconds.
- [x] Preserve last-known values across provider failures.
- [x] Select provider from `MASSIVE_API_KEY`.
- [x] Expose prices through version-aware SSE.
- [x] Support add/remove ticker operations.
- [x] Cover models, cache, factory, simulator, provider, and stream behavior with tests.
- [ ] Add the full application lifespan wiring when the FastAPI application module is introduced.
- [ ] Add an ASGI-level SSE integration test.
- [ ] Add a health endpoint that reports provider freshness and errors.
