# Backend — Developer Guide

## Project Setup

```bash
cd backend
uv sync --extra dev   # Install all dependencies including test/lint tools
```

## Running the Server

```bash
cd backend
uv run uvicorn app.main:app --port 8000          # API on http://localhost:8000
uv run uvicorn app.main:app --port 8000 --reload # auto-reload while developing
```

- `.env` is loaded from the repo root on import (existing env vars win).
- `DB_PATH` sets the SQLite file (default `<repo>/db/finally.db`, created and seeded on startup).
- `STATIC_DIR` sets the Next.js export to serve at `/` (default `backend/static`; skipped if missing).
- `LLM_MOCK=true` makes `/api/chat` deterministic; `MASSIVE_API_KEY` switches to real market data.
- Quick check: `curl localhost:8000/api/health`, `curl -N localhost:8000/api/stream/prices`.

## App Layout

- `app/main.py`: `create_app(source_factory=..., snapshot_interval=...)` builds the app; `app = create_app()`.
  The lifespan runs `init_db()`, builds `PriceCache`, the market source and `TradingService`
  (all on `app.state`), starts the source with watchlist ∪ positions, records a snapshot at
  startup and every 30s. Routers: health, portfolio, watchlist, SSE stream, chat (`app.llm`), then static.
- `app/services/trading.py`: `TradingService`, `TradeError`, `normalize_ticker`. The single place
  that executes trades and edits the watchlist; it keeps the market source tracking watchlist ∪ positions.
- `app/api/`: thin REST routers (TEAM_CONTRACT §4) that map `TradeError` to HTTP 400.
- Tests: `tests/services/fakes.py` has `FakeSource`, a fixed-price source for deterministic tests;
  API tests use `TestClient(create_app(source_factory=...))` with a tmp `DB_PATH`.

## Database

`app/db` (synchronous `sqlite3`, plain dicts): `from app import db`. It re-exports `init_db`,
`get_db_path`, `DEFAULT_TICKERS`, `InsufficientFunds`, `InsufficientShares`, and the CRUD helpers in
TEAM_CONTRACT §3.1 (cash, watchlist, positions, `apply_trade`, trades, snapshots, chat messages).

- `DB_PATH` overrides the file location. It is read at call time, so tests can point it at a `tmp_path`.
- Each call opens a short-lived connection in WAL mode (`busy_timeout=5000`).
- `init_db()` is idempotent and also runs lazily on first use: it creates the schema and seeds the
  default user ($10,000) and the 10 default tickers.
- `apply_trade` is a single transaction. It raises `InsufficientFunds`, `InsufficientShares`, or
  `ValueError` (bad side, qty <= 0 or price <= 0). A sell to zero deletes the position row.
- `get_trades` returns newest first. `get_snapshots` and `get_chat_messages` return the last N, oldest first.

## Market Data API

The market data subsystem lives in `app/market/`. Use these imports:

```python
from app.market import PriceCache, PriceUpdate, MarketDataSource, create_market_data_source
```

### Core Types

- **`PriceUpdate`** — Immutable dataclass: `ticker`, `price`, `previous_price`, `timestamp`, plus properties `change`, `change_percent`, `direction` ("up"/"down"/"flat"), and `to_dict()` for JSON serialization.

- **`PriceCache`** — Thread-safe in-memory store. Key methods:
  - `update(ticker, price, timestamp=None) -> PriceUpdate`
  - `get(ticker) -> PriceUpdate | None`
  - `get_price(ticker) -> float | None`
  - `get_all() -> dict[str, PriceUpdate]`
  - `remove(ticker)`
  - `version` property — monotonic counter, increments on every update (for SSE change detection)

- **`MarketDataSource`** — Abstract interface implemented by `SimulatorDataSource` and `MassiveDataSource`. Lifecycle: `start(tickers)` -> `add_ticker()` / `remove_ticker()` -> `stop()`.

- **`create_market_data_source(cache)`** — Factory. Returns `MassiveDataSource` if `MASSIVE_API_KEY` is set, otherwise `SimulatorDataSource`.

### SSE Streaming

```python
from app.market import create_stream_router

router = create_stream_router(price_cache)  # Returns FastAPI APIRouter
# Endpoint: GET /api/stream/prices (text/event-stream)
```

### Seed Data

Default tickers: AAPL, GOOGL, MSFT, AMZN, TSLA, NVDA, META, JPM, V, NFLX. Seed prices and per-ticker volatility/drift params are in `app/market/seed_prices.py`.

## Running Tests

```bash
uv run --extra dev pytest -v              # All tests
uv run --extra dev pytest --cov=app       # With coverage
uv run --extra dev ruff check app/ tests/ # Lint
```

## Demo

```bash
uv run market_data_demo.py   # Live terminal dashboard with simulated prices
```
