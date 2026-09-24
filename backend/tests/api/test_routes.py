"""REST API tests (TEAM_CONTRACT §4)."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.services.fakes import FakeSource

PORTFOLIO_KEYS = {"cash_balance", "total_value", "positions_value", "unrealized_pnl", "positions"}
POSITION_KEYS = {"ticker", "quantity", "avg_cost", "current_price", "market_value",
                 "unrealized_pnl", "pnl_percent", "weight"}
WATCH_KEYS = {"ticker", "price", "previous_price", "change", "change_percent", "direction",
              "timestamp"}


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_startup_tracks_watchlist_and_records_snapshot(client):
    assert client.source.started
    assert len(client.source.get_tickers()) == 10
    snaps = client.get("/api/portfolio/history").json()["snapshots"]
    assert len(snaps) == 1 and snaps[0]["total_value"] == 10000.0


def test_startup_tracks_positions_off_watchlist(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "x.db"))
    monkeypatch.setenv("STATIC_DIR", str(tmp_path / "no-static"))
    holder: list[FakeSource] = []

    def factory(cache):
        holder.append(FakeSource(cache))
        return holder[-1]

    with TestClient(create_app(source_factory=factory)) as c:
        c.post("/api/portfolio/trade", json={"ticker": "PYPL", "quantity": 1, "side": "buy"})
    assert holder[0].stopped
    # restart against the same DB: PYPL (position only) is tracked from startup
    with TestClient(create_app(source_factory=factory)):
        assert "PYPL" in holder[1].get_tickers()


class TestPortfolio:
    def test_initial(self, client):
        r = client.get("/api/portfolio")
        assert r.status_code == 200
        body = r.json()
        assert set(body) == PORTFOLIO_KEYS
        assert body["cash_balance"] == 10000.0
        assert body["total_value"] == 10000.0
        assert body["positions"] == []

    def test_buy(self, client):
        r = client.post("/api/portfolio/trade", json={"ticker": "aapl", "quantity": 10, "side": "buy"})
        assert r.status_code == 200
        body = r.json()
        assert set(body["trade"]) == {"id", "ticker", "side", "quantity", "price", "executed_at"}
        assert body["trade"]["ticker"] == "AAPL" and body["trade"]["price"] == 190.0
        assert set(body["portfolio"]) == PORTFOLIO_KEYS
        assert body["portfolio"]["cash_balance"] == 8100.0
        pos = body["portfolio"]["positions"][0]
        assert set(pos) == POSITION_KEYS
        assert pos["weight"] == pytest.approx(0.19)
        # a snapshot is recorded after the trade
        assert len(client.get("/api/portfolio/history").json()["snapshots"]) == 2

    def test_sell_all_removes_position(self, client):
        client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 2, "side": "buy"})
        r = client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 2, "side": "sell"})
        assert r.status_code == 200
        assert r.json()["portfolio"]["positions"] == []
        assert r.json()["portfolio"]["cash_balance"] == 10000.0

    @pytest.mark.parametrize("payload,fragment", [
        ({"ticker": "AAPL", "quantity": 1000, "side": "buy"}, "Insufficient cash"),
        ({"ticker": "AAPL", "quantity": 1, "side": "sell"}, "Insufficient shares"),
        ({"ticker": "AAPL", "quantity": 0, "side": "buy"}, "Quantity"),
        ({"ticker": "AAPL", "quantity": -5, "side": "buy"}, "Quantity"),
        ({"ticker": "AAPL", "quantity": 1, "side": "short"}, "Side"),
        ({"ticker": "$$$", "quantity": 1, "side": "buy"}, "Invalid ticker"),
        ({"ticker": "NOPRICE", "quantity": 1, "side": "buy"}, "No price available for NOPRICE"),
    ])
    def test_trade_validation_400(self, client, payload, fragment):
        r = client.post("/api/portfolio/trade", json=payload)
        assert r.status_code == 400
        assert fragment in r.json()["detail"]
        assert client.get("/api/portfolio").json()["cash_balance"] == 10000.0

    @pytest.mark.parametrize("payload", [
        {"ticker": "AAPL", "side": "buy"},
        {"ticker": "AAPL", "quantity": "lots", "side": "buy"},
        {},
    ])
    def test_malformed_body_422(self, client, payload):
        assert client.post("/api/portfolio/trade", json=payload).status_code == 422

    def test_trade_unwatched_ticker(self, client):
        r = client.post("/api/portfolio/trade", json={"ticker": "PYPL", "quantity": 5, "side": "buy"})
        assert r.status_code == 200
        assert r.json()["trade"]["price"] == 60.0
        tickers = [t["ticker"] for t in client.get("/api/watchlist").json()["tickers"]]
        assert "PYPL" not in tickers
        assert "PYPL" in client.source.get_tickers()

    def test_history_shape(self, client):
        r = client.get("/api/portfolio/history")
        assert r.status_code == 200
        snap = r.json()["snapshots"][0]
        assert set(snap) == {"total_value", "recorded_at"}


class TestWatchlist:
    def test_get(self, client):
        r = client.get("/api/watchlist")
        assert r.status_code == 200
        items = r.json()["tickers"]
        assert len(items) == 10
        assert items[0]["ticker"] == "AAPL"
        assert set(items[0]) == WATCH_KEYS
        assert items[0]["price"] == 190.0

    def test_add_then_idempotent(self, client):
        r = client.post("/api/watchlist", json={"ticker": "pypl"})
        assert r.status_code == 201
        assert set(r.json()) == WATCH_KEYS
        assert r.json()["ticker"] == "PYPL" and r.json()["price"] == 60.0
        r2 = client.post("/api/watchlist", json={"ticker": "PYPL"})
        assert r2.status_code == 200
        assert r2.json()["ticker"] == "PYPL"
        tickers = [t["ticker"] for t in client.get("/api/watchlist").json()["tickers"]]
        assert tickers.count("PYPL") == 1 and tickers[-1] == "PYPL"

    def test_add_unpriced_returns_nulls(self, client):
        r = client.post("/api/watchlist", json={"ticker": "NOPRICE"})
        assert r.status_code == 201
        assert r.json()["price"] is None

    def test_add_invalid(self, client):
        r = client.post("/api/watchlist", json={"ticker": "not valid"})
        assert r.status_code == 400
        assert "detail" in r.json()

    def test_add_missing_body_422(self, client):
        assert client.post("/api/watchlist", json={}).status_code == 422

    def test_delete(self, client):
        r = client.delete("/api/watchlist/msft")
        assert r.status_code == 200
        assert r.json() == {"removed": "MSFT"}
        tickers = [t["ticker"] for t in client.get("/api/watchlist").json()["tickers"]]
        assert "MSFT" not in tickers
        assert "MSFT" not in client.source.get_tickers()

    def test_delete_absent_404(self, client):
        r = client.delete("/api/watchlist/PYPL")
        assert r.status_code == 404
        assert "PYPL" in r.json()["detail"]

    def test_delete_with_open_position_keeps_price(self, client):
        client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 1, "side": "buy"})
        assert client.delete("/api/watchlist/AAPL").status_code == 200
        assert "AAPL" in client.source.get_tickers()
        pos = client.get("/api/portfolio").json()["positions"][0]
        assert pos["ticker"] == "AAPL" and pos["current_price"] == 190.0


def test_static_mount_serves_index_without_shadowing_api(tmp_path, monkeypatch):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>FinAlly</html>")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "s.db"))
    monkeypatch.setenv("STATIC_DIR", str(static))
    with TestClient(create_app(source_factory=FakeSource)) as c:
        assert "FinAlly" in c.get("/").text
        assert c.get("/api/health").json() == {"status": "ok"}
