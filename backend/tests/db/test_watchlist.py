"""Watchlist CRUD."""

from app import db


def test_add_new_ticker_appends_in_order():
    assert db.add_to_watchlist("PYPL") is True
    assert db.add_to_watchlist("AMD") is True
    assert db.get_watchlist()[-2:] == ["PYPL", "AMD"]


def test_add_duplicate_returns_false():
    assert db.add_to_watchlist("AAPL") is False
    assert db.get_watchlist().count("AAPL") == 1


def test_add_normalises_ticker():
    assert db.add_to_watchlist("  pypl ") is True
    assert db.add_to_watchlist("PYPL") is False
    assert "PYPL" in db.get_watchlist()


def test_remove_present_and_absent():
    assert db.remove_from_watchlist("tsla") is True
    assert "TSLA" not in db.get_watchlist()
    assert db.remove_from_watchlist("TSLA") is False
    assert db.remove_from_watchlist("ZZZZ") is False


def test_readd_after_remove():
    db.remove_from_watchlist("AAPL")
    assert db.add_to_watchlist("AAPL") is True
    assert db.get_watchlist()[-1] == "AAPL"


def test_users_are_isolated():
    assert db.get_watchlist(user_id="other") == []
    db.add_to_watchlist("AAPL", user_id="other")
    assert db.get_watchlist(user_id="other") == ["AAPL"]
    assert len(db.get_watchlist()) == 10
