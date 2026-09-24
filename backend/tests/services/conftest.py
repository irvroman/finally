import pytest

from app import db
from app.market import PriceCache
from app.services import TradingService

from .fakes import FakeSource

DEFAULT_TICKERS = ["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "JPM", "V", "NFLX"]


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    path = tmp_path / "test.db"
    monkeypatch.setenv("DB_PATH", str(path))
    db.init_db()
    return path


@pytest.fixture
def cache():
    return PriceCache()


@pytest.fixture
def source(cache):
    return FakeSource(cache, prices={"AAPL": 190.0, "MSFT": 400.0, "PYPL": 60.0})


@pytest.fixture
async def service(db_path, cache, source):
    svc = TradingService(cache, source)
    await source.start(svc.tracked_tickers())
    return svc
