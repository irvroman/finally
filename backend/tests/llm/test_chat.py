"""handle_chat orchestration, prompt building, and the chat router."""

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.llm import client as client_module
from app.llm.chat import FAILURE_MESSAGE, handle_chat
from app.llm.prompts import SYSTEM_PROMPT, build_messages, format_portfolio_context
from app.llm.router import create_chat_router

pytestmark = pytest.mark.usefixtures("temp_db")


def fake_completion(content):
    """Build a stand-in for litellm.completion that returns `content` and records its kwargs."""
    calls = []

    def _completion(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])

    _completion.calls = calls
    return _completion


@pytest.fixture
def patch_llm(monkeypatch, mock_off):
    def _patch(content=None, exc=None):
        if exc is not None:
            def _raise(messages):
                raise exc
            monkeypatch.setattr(client_module, "_call_llm_sync", _raise)
            return None
        fake = fake_completion(content)
        monkeypatch.setattr("litellm.completion", fake)
        return fake

    return _patch


class TestMockMode:
    async def test_fallback_message_uses_total_value(self, service, mock_on):
        service.total_value = 12345.678
        body = await handle_chat("hello", service)
        assert body == {
            "message": "This is a mock response from FinAlly. Your portfolio is worth $12345.68.",
            "trades": [],
            "watchlist_changes": [],
        }

    async def test_buy_executes_trade(self, service, mock_on):
        body = await handle_chat("buy 5 AAPL", service)
        assert body["message"] == "Buying 5 shares of AAPL."
        assert body["trades"] == [
            {"ticker": "AAPL", "side": "buy", "quantity": 5.0, "status": "executed", "price": 100.0}
        ]
        assert service.calls == [("trade", "AAPL", "buy", 5.0)]

    async def test_remove_absent_ticker_fails(self, service, mock_on):
        body = await handle_chat("remove ZZZ", service)
        assert body["watchlist_changes"] == [
            {"ticker": "ZZZ", "action": "remove", "status": "failed",
             "error": "ZZZ is not on your watchlist"}
        ]

    async def test_messages_persisted(self, service, mock_on):
        await handle_chat("add PYPL", service)
        msgs = db.get_chat_messages()
        assert [(m["role"], m["content"]) for m in msgs] == [
            ("user", "add PYPL"),
            ("assistant", "Adding PYPL to your watchlist."),
        ]
        assert msgs[0]["actions"] is None
        assert msgs[1]["actions"] == {
            "trades": [],
            "watchlist_changes": [{"ticker": "PYPL", "action": "add", "status": "executed"}],
        }


class TestRealPath:
    async def test_calls_completion_with_cerebras_settings(self, service, patch_llm):
        fake = patch_llm('{"message": "Looks good", "trades": [], "watchlist_changes": []}')
        body = await handle_chat("How am I doing?", service)
        assert body == {"message": "Looks good", "trades": [], "watchlist_changes": []}

        (kwargs,) = fake.calls
        assert kwargs["model"] == "openrouter/openai/gpt-oss-120b"
        assert kwargs["extra_body"] == {"provider": {"order": ["cerebras"]}}
        assert kwargs["reasoning_effort"] == "low"
        assert kwargs["response_format"].__name__ == "LLMResponse"
        assert kwargs["timeout"] == 30.0
        assert kwargs["messages"][0] == {"role": "system", "content": SYSTEM_PROMPT}
        assert "AAPL" in kwargs["messages"][1]["content"]
        assert kwargs["messages"][-1] == {"role": "user", "content": "How am I doing?"}

    async def test_watchlist_changes_applied_before_trades(self, service, patch_llm):
        patch_llm(json.dumps({
            "message": "On it",
            "trades": [{"ticker": "pypl", "side": "buy", "quantity": 2}],
            "watchlist_changes": [{"ticker": "PYPL", "action": "add"}],
        }))
        await handle_chat("add and buy PYPL", service)
        assert service.calls == [("add", "PYPL"), ("trade", "PYPL", "buy", 2.0)]

    async def test_partial_failure_does_not_stop_other_actions(self, service, patch_llm):
        service.fail = {"TSLA", "BAD"}
        patch_llm(json.dumps({
            "message": "Executing",
            "trades": [
                {"ticker": "TSLA", "side": "buy", "quantity": 1000},
                {"ticker": "AAPL", "side": "sell", "quantity": 1},
            ],
            "watchlist_changes": [
                {"ticker": "BAD", "action": "add"},
                {"ticker": "MSFT", "action": "remove"},
            ],
        }))
        body = await handle_chat("do it", service)

        assert body["trades"] == [
            {"ticker": "TSLA", "side": "buy", "quantity": 1000.0, "status": "failed",
             "error": "Insufficient cash to buy 1000.0 TSLA"},
            {"ticker": "AAPL", "side": "sell", "quantity": 1.0, "status": "executed", "price": 100.0},
        ]
        assert body["watchlist_changes"] == [
            {"ticker": "BAD", "action": "add", "status": "failed", "error": "Invalid ticker: BAD"},
            {"ticker": "MSFT", "action": "remove", "status": "executed"},
        ]
        assert "error" not in body
        stored = db.get_chat_messages()[-1]
        assert stored["actions"] == {"trades": body["trades"],
                                     "watchlist_changes": body["watchlist_changes"]}

    async def test_history_included_and_capped(self, service, patch_llm):
        for i in range(25):
            db.add_chat_message("user" if i % 2 == 0 else "assistant", f"m{i}")
        fake = patch_llm('{"message": "ok"}')
        await handle_chat("latest", service)

        convo = fake.calls[0]["messages"][2:]
        assert len(convo) == 21  # 20 history + new message
        assert convo[0]["content"] == "m5"
        assert convo[-2]["content"] == "m24"
        assert convo[-1] == {"role": "user", "content": "latest"}

    @pytest.mark.parametrize(
        ("exc", "reason"),
        [
            (RuntimeError("AuthenticationError: bad key"), "RuntimeError: AuthenticationError: bad key"),
            (TimeoutError(), "AI service timed out"),
        ],
    )
    async def test_llm_exception_returns_error_response(self, service, patch_llm, exc, reason):
        patch_llm(exc=exc)
        body = await handle_chat("hello", service)
        assert body == {"message": FAILURE_MESSAGE, "trades": [], "watchlist_changes": [],
                        "error": reason}
        # User message stored; error reply not stored.
        assert [m["role"] for m in db.get_chat_messages()] == ["user"]
        assert service.calls == []

    async def test_malformed_llm_output_returns_error_response(self, service, patch_llm):
        patch_llm("I think you should buy AAPL")
        body = await handle_chat("hello", service)
        assert body["message"] == FAILURE_MESSAGE
        assert body["error"] == "Malformed response from AI service"
        assert [m["role"] for m in db.get_chat_messages()] == ["user"]

    async def test_slow_llm_times_out(self, service, mock_off, monkeypatch):
        monkeypatch.setattr(client_module, "TIMEOUT_SECONDS", 0.05)

        def _slow(messages):
            import time
            time.sleep(0.5)
            return '{"message": "late"}'

        monkeypatch.setattr(client_module, "_call_llm_sync", _slow)
        body = await handle_chat("hello", service)
        assert body["error"] == "AI service timed out"


class TestPrompts:
    def test_context_contains_portfolio_numbers(self, service):
        text = format_portfolio_context(service.get_portfolio(), service.get_watchlist())
        assert "Cash: $5,000.00" in text
        assert "Total value: $10,000.00" in text
        assert "AAPL: 25.0 sh @ avg $190.00" in text
        assert "+5.26%" in text and "weight 50.0%" in text
        assert "MSFT: $200.00" in text

    def test_context_handles_empty_and_missing_prices(self):
        text = format_portfolio_context(
            {"cash_balance": 10000.0, "total_value": 10000.0, "positions": []},
            [{"ticker": "AAPL", "price": None, "change_percent": None}],
        )
        assert "Positions: none" in text
        assert "AAPL: n/a" in text

    def test_assistant_history_includes_actions(self):
        msgs = build_messages(
            "next",
            "ctx",
            [
                {"role": "user", "content": "buy 1 AAPL", "actions": None},
                {"role": "assistant", "content": "Bought",
                 "actions": {"trades": [{"ticker": "AAPL", "status": "executed"}]}},
            ],
        )
        assert msgs[2] == {"role": "user", "content": "buy 1 AAPL"}
        assert msgs[3]["content"].startswith("Bought\n[Executed actions:")
        assert '"ticker":"AAPL"' in msgs[3]["content"]


class TestRouter:
    @pytest.fixture
    def client(self, service):
        app = FastAPI()
        app.include_router(create_chat_router(lambda: service))
        return TestClient(app)

    def test_post_chat_mock(self, client, mock_on):
        r = client.post("/api/chat", json={"message": "  buy 2 MSFT  "})
        assert r.status_code == 200
        assert r.json()["message"] == "Buying 2 shares of MSFT."
        assert r.json()["trades"][0]["status"] == "executed"

    @pytest.mark.parametrize("payload", [{}, {"message": ""}, {"message": "   "}, {"message": 5}])
    def test_post_chat_validation(self, client, payload):
        assert client.post("/api/chat", json=payload).status_code == 422

    def test_history(self, client, mock_on):
        client.post("/api/chat", json={"message": "hello"})
        r = client.get("/api/chat/history")
        assert r.status_code == 200
        msgs = r.json()["messages"]
        assert [m["role"] for m in msgs] == ["user", "assistant"]
        assert set(msgs[0]) >= {"id", "role", "content", "actions", "created_at"}

    def test_history_empty(self, client):
        assert client.get("/api/chat/history").json() == {"messages": []}

