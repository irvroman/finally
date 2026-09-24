"""apply_trade: cash, position and trade log math and validation."""

import sqlite3

import pytest

from app import db


class TestBuy:
    def test_first_buy_creates_position(self):
        trade = db.apply_trade("AAPL", "buy", 10, 190.0)
        assert trade["ticker"] == "AAPL"
        assert trade["side"] == "buy"
        assert trade["quantity"] == 10
        assert trade["price"] == 190.0
        assert set(trade) == {"id", "ticker", "side", "quantity", "price", "executed_at"}
        assert db.get_cash() == pytest.approx(8100.0)
        pos = db.get_position("AAPL")
        assert pos["quantity"] == 10
        assert pos["avg_cost"] == 190.0
        assert set(pos) == {"ticker", "quantity", "avg_cost", "updated_at"}

    def test_second_buy_averages_cost(self):
        db.apply_trade("AAPL", "buy", 10, 100.0)
        db.apply_trade("AAPL", "buy", 30, 200.0)
        pos = db.get_position("AAPL")
        assert pos["quantity"] == 40
        assert pos["avg_cost"] == pytest.approx((10 * 100 + 30 * 200) / 40)
        assert db.get_cash() == pytest.approx(10000 - 1000 - 6000)

    def test_buy_exactly_all_cash(self):
        db.apply_trade("AAPL", "buy", 100, 100.0)
        assert db.get_cash() == pytest.approx(0.0)

    def test_insufficient_funds(self):
        with pytest.raises(db.InsufficientFunds):
            db.apply_trade("AAPL", "buy", 101, 100.0)
        assert db.get_cash() == 10000.0
        assert db.get_position("AAPL") is None
        assert db.get_trades() == []

    def test_lowercase_ticker_and_side_normalised(self):
        trade = db.apply_trade(" msft ", "BUY", 1, 400.0)
        assert trade["ticker"] == "MSFT"
        assert trade["side"] == "buy"
        assert db.get_position("msft")["quantity"] == 1

    def test_buy_unwatched_ticker_does_not_touch_watchlist(self):
        db.apply_trade("PYPL", "buy", 1, 60.0)
        assert "PYPL" not in db.get_watchlist()
        assert db.get_position("PYPL") is not None


class TestSell:
    def test_partial_sell_keeps_avg_cost(self):
        db.apply_trade("AAPL", "buy", 10, 100.0)
        db.apply_trade("AAPL", "sell", 4, 150.0)
        pos = db.get_position("AAPL")
        assert pos["quantity"] == 6
        assert pos["avg_cost"] == 100.0
        assert db.get_cash() == pytest.approx(10000 - 1000 + 600)

    def test_sell_at_loss(self):
        db.apply_trade("AAPL", "buy", 10, 100.0)
        db.apply_trade("AAPL", "sell", 10, 80.0)
        assert db.get_cash() == pytest.approx(9800.0)

    def test_sell_to_zero_deletes_row(self, db_path):
        db.apply_trade("AAPL", "buy", 5, 100.0)
        db.apply_trade("AAPL", "sell", 5, 100.0)
        assert db.get_position("AAPL") is None
        assert db.get_positions() == []
        with sqlite3.connect(db_path) as conn:
            assert conn.execute("SELECT COUNT(*) FROM positions").fetchone()[0] == 0

    def test_rebuy_after_close_gets_fresh_avg_cost(self):
        db.apply_trade("AAPL", "buy", 5, 100.0)
        db.apply_trade("AAPL", "sell", 5, 100.0)
        db.apply_trade("AAPL", "buy", 2, 300.0)
        assert db.get_position("AAPL")["avg_cost"] == 300.0

    def test_sell_more_than_held(self):
        db.apply_trade("AAPL", "buy", 5, 100.0)
        with pytest.raises(db.InsufficientShares):
            db.apply_trade("AAPL", "sell", 6, 100.0)
        assert db.get_position("AAPL")["quantity"] == 5
        assert db.get_cash() == pytest.approx(9500.0)
        assert len(db.get_trades()) == 1

    def test_sell_without_position(self):
        with pytest.raises(db.InsufficientShares):
            db.apply_trade("AAPL", "sell", 1, 100.0)
        assert db.get_cash() == 10000.0

    def test_float_dust_within_tolerance_closes_position(self):
        db.apply_trade("AAPL", "buy", 0.1, 100.0)
        db.apply_trade("AAPL", "buy", 0.2, 100.0)  # 0.30000000000000004 held
        db.apply_trade("AAPL", "sell", 0.3, 100.0)
        assert db.get_position("AAPL") is None


class TestFractional:
    def test_fractional_buy_and_sell(self):
        db.apply_trade("NVDA", "buy", 0.5, 800.0)
        db.apply_trade("NVDA", "buy", 1.25, 900.0)
        pos = db.get_position("NVDA")
        assert pos["quantity"] == pytest.approx(1.75)
        assert pos["avg_cost"] == pytest.approx((0.5 * 800 + 1.25 * 900) / 1.75)
        db.apply_trade("NVDA", "sell", 0.75, 1000.0)
        assert db.get_position("NVDA")["quantity"] == pytest.approx(1.0)
        assert db.get_cash() == pytest.approx(10000 - 400 - 1125 + 750)


class TestInvalidInput:
    @pytest.mark.parametrize(
        "ticker,side,qty,price",
        [
            ("AAPL", "hold", 1, 100),
            ("AAPL", "buy", 0, 100),
            ("AAPL", "buy", -1, 100),
            ("AAPL", "buy", 1, 0),
            ("AAPL", "sell", 1, -5),
            ("   ", "buy", 1, 100),
            ("AAPL", "buy", float("nan"), 100),
        ],
    )
    def test_value_error_and_no_side_effects(self, ticker, side, qty, price):
        with pytest.raises(ValueError):
            db.apply_trade(ticker, side, qty, price)
        assert db.get_cash() == 10000.0
        assert db.get_trades() == []


class TestTradeLog:
    def test_trades_newest_first_and_limit(self):
        db.apply_trade("AAPL", "buy", 1, 100.0)
        db.apply_trade("MSFT", "buy", 1, 100.0)
        db.apply_trade("AAPL", "sell", 1, 110.0)
        trades = db.get_trades()
        assert [(t["ticker"], t["side"]) for t in trades] == [
            ("AAPL", "sell"),
            ("MSFT", "buy"),
            ("AAPL", "buy"),
        ]
        assert len(db.get_trades(limit=2)) == 2

    def test_returned_trade_matches_log(self):
        trade = db.apply_trade("AAPL", "buy", 2, 150.0)
        assert db.get_trades()[0] == trade

    def test_positions_sorted_by_ticker(self):
        db.apply_trade("TSLA", "buy", 1, 100.0)
        db.apply_trade("AAPL", "buy", 1, 100.0)
        assert [p["ticker"] for p in db.get_positions()] == ["AAPL", "TSLA"]

    def test_transaction_rolls_back_on_failure(self, monkeypatch):
        """If the trade insert fails, cash and position changes are rolled back."""
        from app.db import repository

        # Force the trade insert to fail by making it collide with an existing trade id.
        existing = db.apply_trade("AAPL", "buy", 1, 100.0)
        monkeypatch.setattr(repository, "new_id", lambda: existing["id"])
        with pytest.raises(sqlite3.IntegrityError):
            db.apply_trade("MSFT", "buy", 1, 100.0)
        assert db.get_cash() == pytest.approx(9900.0)
        assert db.get_position("MSFT") is None
        assert len(db.get_trades()) == 1
