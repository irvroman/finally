"""Tests for TradingService."""

import pytest

from app import db
from app.services import TradeError, TradingService, normalize_ticker

from .conftest import DEFAULT_TICKERS
from .fakes import FakeSource


class TestNormalizeTicker:
    @pytest.mark.parametrize("raw,expected", [("aapl", "AAPL"), ("  msft ", "MSFT"),
                                              ("brk.b", "BRK.B"), ("X", "X"), ("A1234567890"[:10], "A123456789")])
    def test_valid(self, raw, expected):
        assert normalize_ticker(raw) == expected

    @pytest.mark.parametrize("raw", ["", "   ", "1ABC", "AB-C", "ABCDEFGHIJK", ".A", "A B", None, 5])
    def test_invalid(self, raw):
        with pytest.raises(TradeError):
            normalize_ticker(raw)


class TestBuy:
    async def test_buy_updates_cash_position_and_snapshot(self, service):
        trade = await service.execute_trade("aapl", "buy", 10)
        assert trade["ticker"] == "AAPL"
        assert trade["side"] == "buy"
        assert trade["quantity"] == 10
        assert trade["price"] == 190.0
        assert {"id", "executed_at"} <= trade.keys()
        assert db.get_cash() == pytest.approx(10000 - 1900)
        pos = db.get_position("AAPL")
        assert pos["quantity"] == 10
        assert pos["avg_cost"] == 190.0
        snaps = db.get_snapshots()
        assert snaps[-1]["total_value"] == pytest.approx(10000)

    async def test_average_cost_updates_on_second_buy(self, service, source):
        await service.execute_trade("AAPL", "buy", 10)
        source.set_price("AAPL", 210.0)
        await service.execute_trade("AAPL", "buy", 10)
        assert db.get_position("AAPL")["avg_cost"] == pytest.approx(200.0)

    async def test_insufficient_cash(self, service):
        with pytest.raises(TradeError, match="Insufficient cash"):
            await service.execute_trade("AAPL", "buy", 1000)
        assert db.get_cash() == 10000
        assert db.get_position("AAPL") is None

    async def test_buy_exactly_all_cash(self, service, source):
        source.set_price("AAPL", 100.0)
        await service.execute_trade("AAPL", "buy", 100)
        assert db.get_cash() == pytest.approx(0)

    async def test_fractional_quantity_rounded_to_4dp(self, service):
        trade = await service.execute_trade("AAPL", "buy", 0.123456)
        assert trade["quantity"] == pytest.approx(0.1235)

    @pytest.mark.parametrize("qty", [0, -1, 0.00001, float("nan"), float("inf"), "abc"])
    async def test_invalid_quantity(self, service, qty):
        with pytest.raises(TradeError, match="Quantity"):
            await service.execute_trade("AAPL", "buy", qty)

    @pytest.mark.parametrize("side", ["hold", "", None])
    async def test_invalid_side(self, service, side):
        with pytest.raises(TradeError, match="Side"):
            await service.execute_trade("AAPL", side, 1)

    async def test_side_is_case_insensitive(self, service):
        trade = await service.execute_trade("AAPL", "BUY", 1)
        assert trade["side"] == "buy"

    async def test_invalid_ticker(self, service):
        with pytest.raises(TradeError, match="Invalid ticker"):
            await service.execute_trade("not a ticker", "buy", 1)


class TestSell:
    async def test_partial_sell(self, service, source):
        await service.execute_trade("AAPL", "buy", 10)
        source.set_price("AAPL", 200.0)
        await service.execute_trade("AAPL", "sell", 4)
        pos = db.get_position("AAPL")
        assert pos["quantity"] == pytest.approx(6)
        assert pos["avg_cost"] == 190.0  # unchanged on sells
        assert db.get_cash() == pytest.approx(10000 - 1900 + 800)

    async def test_sell_at_loss(self, service, source):
        await service.execute_trade("AAPL", "buy", 10)
        source.set_price("AAPL", 150.0)
        await service.execute_trade("AAPL", "sell", 10)
        assert db.get_cash() == pytest.approx(10000 - 400)

    async def test_full_sell_deletes_position(self, service):
        await service.execute_trade("AAPL", "buy", 5)
        await service.execute_trade("AAPL", "sell", 5)
        assert db.get_position("AAPL") is None
        assert service.get_portfolio()["positions"] == []

    async def test_sell_more_than_held(self, service):
        await service.execute_trade("AAPL", "buy", 5)
        with pytest.raises(TradeError, match="Insufficient shares"):
            await service.execute_trade("AAPL", "sell", 6)
        assert db.get_position("AAPL")["quantity"] == 5

    async def test_sell_with_no_position(self, service):
        with pytest.raises(TradeError, match="Insufficient shares"):
            await service.execute_trade("AAPL", "sell", 1)

    async def test_trades_are_logged(self, service):
        await service.execute_trade("AAPL", "buy", 2)
        await service.execute_trade("AAPL", "sell", 1)
        sides = sorted(t["side"] for t in db.get_trades())
        assert sides == ["buy", "sell"]


class TestTickerTracking:
    async def test_starts_with_watchlist(self, service, source):
        assert source.get_tickers() == DEFAULT_TICKERS
        assert service.tracked_tickers() == DEFAULT_TICKERS

    async def test_trade_unwatched_ticker(self, service, source):
        await service.execute_trade("PYPL", "buy", 10)
        assert "PYPL" in source.get_tickers()
        assert "PYPL" not in db.get_watchlist()
        assert db.get_position("PYPL")["avg_cost"] == 60.0
        assert "PYPL" in service.tracked_tickers()

    async def test_closing_unwatched_position_untracks(self, service, source, cache):
        await service.execute_trade("PYPL", "buy", 10)
        await service.execute_trade("PYPL", "sell", 10)
        assert "PYPL" not in source.get_tickers()
        assert cache.get("PYPL") is None

    async def test_closing_watched_position_keeps_tracking(self, service, source):
        await service.execute_trade("AAPL", "buy", 1)
        await service.execute_trade("AAPL", "sell", 1)
        assert "AAPL" in source.get_tickers()

    async def test_failed_trade_on_unwatched_ticker_untracks(self, service, source):
        with pytest.raises(TradeError):
            await service.execute_trade("PYPL", "sell", 1)
        assert "PYPL" not in source.get_tickers()

    async def test_no_price_available(self, db_path, cache):
        source = FakeSource(cache, unpriced={"ZZZ"})
        svc = TradingService(cache, source)
        await source.start(svc.tracked_tickers())
        with pytest.raises(TradeError, match="No price available for ZZZ"):
            await svc.execute_trade("zzz", "buy", 1)
        assert "ZZZ" not in source.get_tickers()
        assert db.get_cash() == 10000

    async def test_remove_watchlist_ticker_with_open_position_stays_tracked(self, service, source):
        await service.execute_trade("AAPL", "buy", 3)
        assert await service.remove_from_watchlist("AAPL") is True
        assert "AAPL" not in db.get_watchlist()
        assert "AAPL" in source.get_tickers()
        # position is still valued at the live price
        pos = service.get_portfolio()["positions"][0]
        assert pos["ticker"] == "AAPL" and pos["current_price"] == 190.0
        # closing it now untracks it
        await service.execute_trade("AAPL", "sell", 3)
        assert "AAPL" not in source.get_tickers()

    async def test_remove_watchlist_ticker_without_position_untracks(self, service, source, cache):
        assert await service.remove_from_watchlist("msft") is True
        assert "MSFT" not in source.get_tickers()
        assert cache.get("MSFT") is None


class TestWatchlist:
    async def test_get_watchlist_shape(self, service):
        items = service.get_watchlist()
        assert [i["ticker"] for i in items] == DEFAULT_TICKERS
        aapl = items[0]
        assert set(aapl) == {"ticker", "price", "previous_price", "change",
                             "change_percent", "direction", "timestamp"}
        assert aapl["price"] == 190.0

    async def test_add_is_idempotent(self, service, source):
        item = await service.add_to_watchlist(" pypl ")
        assert item["ticker"] == "PYPL" and item["price"] == 60.0
        await service.add_to_watchlist("PYPL")
        assert db.get_watchlist().count("PYPL") == 1
        assert source.get_tickers().count("PYPL") == 1

    async def test_add_unpriced_ticker_has_null_prices(self, db_path, cache):
        source = FakeSource(cache, unpriced={"NEWCO"})
        svc = TradingService(cache, source)
        await source.start(svc.tracked_tickers())
        item = await svc.add_to_watchlist("NEWCO")
        assert item["price"] is None and item["direction"] is None

    async def test_add_invalid(self, service):
        with pytest.raises(TradeError):
            await service.add_to_watchlist("bad ticker!")

    async def test_remove_absent(self, service):
        assert await service.remove_from_watchlist("PYPL") is False
        assert await service.remove_from_watchlist("not valid!") is False


class TestPortfolio:
    async def test_empty_portfolio(self, service):
        p = service.get_portfolio()
        assert p == {"cash_balance": 10000.0, "total_value": 10000.0, "positions_value": 0.0,
                     "unrealized_pnl": 0.0, "positions": []}

    async def test_valuation_and_pnl(self, service, source):
        await service.execute_trade("AAPL", "buy", 10)   # 1900
        await service.execute_trade("MSFT", "buy", 5)    # 2000
        source.set_price("AAPL", 209.0)                  # +10%
        source.set_price("MSFT", 380.0)                  # -5%
        p = service.get_portfolio()
        assert p["cash_balance"] == 6100.0
        assert p["positions_value"] == 2090.0 + 1900.0
        assert p["total_value"] == 6100.0 + 3990.0
        assert p["unrealized_pnl"] == 190.0 - 100.0
        by = {r["ticker"]: r for r in p["positions"]}
        assert by["AAPL"] == {
            "ticker": "AAPL", "quantity": 10, "avg_cost": 190.0, "current_price": 209.0,
            "market_value": 2090.0, "unrealized_pnl": 190.0, "pnl_percent": 10.0,
            "weight": round(2090 / 10090, 4),
        }
        assert by["MSFT"]["pnl_percent"] == -5.0
        assert by["MSFT"]["unrealized_pnl"] == -100.0

    async def test_missing_price_falls_back_to_avg_cost(self, service, cache):
        await service.execute_trade("AAPL", "buy", 10)
        cache.remove("AAPL")
        row = service.get_portfolio()["positions"][0]
        assert row["current_price"] == 190.0
        assert row["unrealized_pnl"] == 0.0
        assert service.total_value() == pytest.approx(10000)

    async def test_history(self, service, source):
        await service.record_snapshot()
        await service.execute_trade("AAPL", "buy", 10)
        source.set_price("AAPL", 200.0)
        await service.record_snapshot()
        history = service.get_history()
        assert [h["total_value"] for h in history] == [10000.0, 10000.0, 10100.0]
        assert set(history[0]) == {"total_value", "recorded_at"}
