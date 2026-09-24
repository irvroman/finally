"""Mock-mode grammar (TEAM_CONTRACT.md §3.3). E2E tests depend on these exact strings."""

import pytest

from app.llm.mock import is_mock_enabled, mock_response


class TestGrammar:
    def test_buy(self):
        r = mock_response("buy 5 AAPL", 10000.0)
        assert r.message == "Buying 5 shares of AAPL."
        assert [(t.ticker, t.side, t.quantity) for t in r.trades] == [("AAPL", "buy", 5.0)]
        assert r.watchlist_changes == []

    def test_sell_case_insensitive_and_uppercases_ticker(self):
        r = mock_response("SELL 2.5 tsla", 10000.0)
        assert r.message == "Selling 2.5 shares of TSLA."
        assert [(t.ticker, t.side, t.quantity) for t in r.trades] == [("TSLA", "sell", 2.5)]

    def test_buy_inside_sentence(self):
        r = mock_response("Please buy 10 NVDA for me.", 10000.0)
        assert r.message == "Buying 10 shares of NVDA."

    def test_trailing_period_stripped_from_ticker(self):
        assert mock_response("buy 1 AAPL.", 0).trades[0].ticker == "AAPL"

    @pytest.mark.parametrize("verb", ["add", "watch", "Add", "WATCH"])
    def test_add_and_watch(self, verb):
        r = mock_response(f"{verb} pypl", 10000.0)
        assert r.message == "Adding PYPL to your watchlist."
        assert [(w.ticker, w.action) for w in r.watchlist_changes] == [("PYPL", "add")]
        assert r.trades == []

    def test_remove(self):
        r = mock_response("remove NFLX", 10000.0)
        assert r.message == "Removing NFLX from your watchlist."
        assert [(w.ticker, w.action) for w in r.watchlist_changes] == [("NFLX", "remove")]

    def test_first_rule_wins(self):
        r = mock_response("buy 3 AAPL and remove MSFT", 10000.0)
        assert r.message == "Buying 3 shares of AAPL."
        assert r.watchlist_changes == []

    @pytest.mark.parametrize("text", ["hello", "how is my portfolio?", "buy AAPL", "addAAPL"])
    def test_fallback(self, text):
        r = mock_response(text, 10234.5)
        assert r.message == "This is a mock response from FinAlly. Your portfolio is worth $10234.50."
        assert r.trades == [] and r.watchlist_changes == []


@pytest.mark.parametrize(
    ("value", "expected"),
    [("true", True), ("TRUE", True), ("1", True), ("false", False), ("", False)],
)
def test_is_mock_enabled(monkeypatch, value, expected):
    monkeypatch.setenv("LLM_MOCK", value)
    assert is_mock_enabled() is expected


def test_is_mock_disabled_when_unset(monkeypatch):
    monkeypatch.delenv("LLM_MOCK", raising=False)
    assert is_mock_enabled() is False
