"""Deterministic MarketDataSource for service and API tests."""

from app.market import MarketDataSource, PriceCache


class FakeSource(MarketDataSource):
    """Seeds fixed prices into the cache; tickers in `unpriced` never get a price."""

    def __init__(self, cache: PriceCache, prices: dict[str, float] | None = None,
                 default_price: float = 100.0, unpriced: set[str] | None = None) -> None:
        self.cache = cache
        self.prices = dict(prices or {})
        self.default_price = default_price
        self.unpriced = set(unpriced or ())
        self.tickers: list[str] = []
        self.started = False
        self.stopped = False

    def _seed(self, ticker: str) -> None:
        if ticker not in self.unpriced:
            self.cache.update(ticker, self.prices.get(ticker, self.default_price))

    def set_price(self, ticker: str, price: float) -> None:
        self.prices[ticker] = price
        if ticker in self.tickers:
            self.cache.update(ticker, price)

    async def start(self, tickers: list[str]) -> None:
        self.started = True
        for t in tickers:
            await self.add_ticker(t)

    async def stop(self) -> None:
        self.stopped = True

    async def add_ticker(self, ticker: str) -> None:
        if ticker not in self.tickers:
            self.tickers.append(ticker)
            self._seed(ticker)

    async def remove_ticker(self, ticker: str) -> None:
        if ticker in self.tickers:
            self.tickers.remove(ticker)
        self.cache.remove(ticker)

    def get_tickers(self) -> list[str]:
        return list(self.tickers)
