"""Fixtures for LLM tests: a temp SQLite DB and a fake TradingService."""

import pytest

from app import db


class FakeTradeError(Exception):
    pass


class FakeTradingService:
    """Records calls; fails any ticker listed in `fail` with a user-facing message."""

    def __init__(self, total_value: float = 10000.0, fail: set[str] | None = None):
        self.total_value = total_value
        self.fail = fail or set()
        self.calls: list[tuple] = []
        self.watchlist = ["AAPL", "MSFT"]

    async def execute_trade(self, ticker, side, quantity):
        self.calls.append(("trade", ticker, side, quantity))
        if ticker in self.fail:
            raise FakeTradeError(f"Insufficient cash to buy {quantity} {ticker}")
        return {
            "id": "t1",
            "ticker": ticker,
            "side": side,
            "quantity": quantity,
            "price": 100.0,
            "executed_at": "2026-01-01T00:00:00+00:00",
        }

    async def add_to_watchlist(self, ticker):
        self.calls.append(("add", ticker))
        if ticker in self.fail:
            raise FakeTradeError(f"Invalid ticker: {ticker}")
        if ticker not in self.watchlist:
            self.watchlist.append(ticker)
        return {"ticker": ticker, "price": None}

    async def remove_from_watchlist(self, ticker):
        self.calls.append(("remove", ticker))
        if ticker in self.watchlist:
            self.watchlist.remove(ticker)
            return True
        return False

    def get_portfolio(self):
        return {
            "cash_balance": 5000.0,
            "total_value": self.total_value,
            "positions_value": 5000.0,
            "unrealized_pnl": 250.0,
            "positions": [
                {
                    "ticker": "AAPL",
                    "quantity": 25.0,
                    "avg_cost": 190.0,
                    "current_price": 200.0,
                    "market_value": 5000.0,
                    "unrealized_pnl": 250.0,
                    "pnl_percent": 5.26,
                    "weight": 0.5,
                }
            ],
        }

    def get_watchlist(self):
        return [
            {"ticker": t, "price": 200.0, "previous_price": 199.0, "change": 1.0,
             "change_percent": 0.5, "direction": "up", "timestamp": 1.0}
            for t in self.watchlist
        ]


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    path = tmp_path / "test.db"
    monkeypatch.setenv("DB_PATH", str(path))
    db.init_db(path)
    return path


@pytest.fixture
def service():
    return FakeTradingService()


@pytest.fixture
def mock_on(monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "true")


@pytest.fixture
def mock_off(monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "false")
