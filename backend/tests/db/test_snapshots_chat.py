"""Portfolio snapshots and chat messages."""

from datetime import datetime

import pytest

from app import db


class TestSnapshots:
    def test_record_returns_row(self):
        snap = db.record_snapshot(10123.45)
        assert set(snap) == {"id", "total_value", "recorded_at"}
        assert snap["total_value"] == 10123.45
        assert datetime.fromisoformat(snap["recorded_at"]).tzinfo is not None
        assert db.get_snapshots() == [snap]

    def test_oldest_to_newest(self):
        for v in (1.0, 2.0, 3.0):
            db.record_snapshot(v)
        assert [s["total_value"] for s in db.get_snapshots()] == [1.0, 2.0, 3.0]

    def test_limit_keeps_most_recent(self):
        for v in range(10):
            db.record_snapshot(float(v))
        assert [s["total_value"] for s in db.get_snapshots(limit=3)] == [7.0, 8.0, 9.0]

    def test_users_are_isolated(self):
        db.record_snapshot(1.0, user_id="other")
        assert db.get_snapshots() == []
        assert len(db.get_snapshots(user_id="other")) == 1


class TestChat:
    def test_user_message_round_trip(self):
        msg = db.add_chat_message("user", "buy 5 AAPL")
        assert msg["actions"] is None
        assert set(msg) == {"id", "role", "content", "actions", "created_at"}
        assert db.get_chat_messages() == [msg]

    def test_actions_json_round_trip(self):
        actions = {
            "trades": [
                {
                    "ticker": "AAPL",
                    "side": "buy",
                    "quantity": 5,
                    "status": "executed",
                    "price": 190.5,
                }
            ],
            "watchlist_changes": [
                {"ticker": "PYPL", "action": "add", "status": "failed", "error": "nope"}
            ],
        }
        db.add_chat_message("assistant", "Done.", actions)
        [stored] = db.get_chat_messages()
        assert stored["role"] == "assistant"
        assert stored["content"] == "Done."
        assert stored["actions"] == actions

    def test_empty_actions_dict_preserved(self):
        db.add_chat_message("assistant", "ok", {})
        assert db.get_chat_messages()[0]["actions"] == {}

    def test_order_and_limit(self):
        for i in range(25):
            db.add_chat_message("user" if i % 2 == 0 else "assistant", f"m{i}")
        msgs = db.get_chat_messages()
        assert len(msgs) == 20
        assert [m["content"] for m in msgs] == [f"m{i}" for i in range(5, 25)]
        assert [m["content"] for m in db.get_chat_messages(limit=2)] == ["m23", "m24"]

    def test_invalid_role(self):
        with pytest.raises(ValueError):
            db.add_chat_message("system", "hi")
        assert db.get_chat_messages() == []

    def test_unicode_content(self):
        db.add_chat_message("user", "What about €uro stocks? 📈")
        assert db.get_chat_messages()[0]["content"] == "What about €uro stocks? 📈"
