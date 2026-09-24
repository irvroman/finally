"""Structured output parsing."""

import pytest

from app.llm.client import LLMResponseError, parse_llm_response
from app.llm.schemas import LLMResponse


class TestValidShapes:
    def test_message_only(self):
        r = parse_llm_response('{"message": "Hi"}')
        assert r.message == "Hi"
        assert r.trades == [] and r.watchlist_changes == []

    def test_empty_action_lists(self):
        r = parse_llm_response('{"message": "Hi", "trades": [], "watchlist_changes": []}')
        assert r.trades == [] and r.watchlist_changes == []

    def test_trades_and_watchlist(self):
        r = parse_llm_response(
            '{"message": "Done", '
            '"trades": [{"ticker": "AAPL", "side": "buy", "quantity": 10}, '
            '{"ticker": "TSLA", "side": "sell", "quantity": 0.5}], '
            '"watchlist_changes": [{"ticker": "PYPL", "action": "add"}, '
            '{"ticker": "NFLX", "action": "remove"}]}'
        )
        assert [(t.ticker, t.side, t.quantity) for t in r.trades] == [
            ("AAPL", "buy", 10.0),
            ("TSLA", "sell", 0.5),
        ]
        assert [(w.ticker, w.action) for w in r.watchlist_changes] == [
            ("PYPL", "add"),
            ("NFLX", "remove"),
        ]

    def test_code_fenced_json(self):
        r = parse_llm_response('```json\n{"message": "Fenced"}\n```')
        assert r.message == "Fenced"

    def test_json_wrapped_in_prose(self):
        r = parse_llm_response('Here you go: {"message": "Wrapped", "trades": []} hope that helps')
        assert r.message == "Wrapped"

    def test_quantity_as_string_number_coerced(self):
        r = parse_llm_response(
            '{"message": "x", "trades": [{"ticker": "AAPL", "side": "buy", "quantity": "3"}]}'
        )
        assert r.trades[0].quantity == 3.0


class TestMalformed:
    @pytest.mark.parametrize(
        "content",
        [
            None,
            "",
            "   ",
            "not json at all",
            '{"message": "unterminated',
            '{"trades": []}',  # missing message
            '{"message": "x", "trades": [{"ticker": "AAPL", "side": "hold", "quantity": 1}]}',
            '{"message": "x", "watchlist_changes": [{"ticker": "AAPL", "action": "delete"}]}',
            '{"message": "x", "trades": [{"ticker": "AAPL", "side": "buy"}]}',
            "[1, 2, 3]",
        ],
    )
    def test_raises_llm_response_error(self, content):
        with pytest.raises(LLMResponseError):
            parse_llm_response(content)


def test_schema_is_json_schema_serializable():
    schema = LLMResponse.model_json_schema()
    assert schema["required"] == ["message"]
    assert set(schema["properties"]) == {"message", "trades", "watchlist_changes"}
