"""Schema creation, seeding, path resolution and connection pragmas."""

import sqlite3

from app import db
from app.db.connection import DEFAULT_DB_PATH, connect

TABLES = {
    "users_profile",
    "watchlist",
    "positions",
    "trades",
    "portfolio_snapshots",
    "chat_messages",
}


def _tables(path):
    with sqlite3.connect(path) as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {r[0] for r in rows}


class TestDbPath:
    def test_honours_env_at_call_time(self, db_path, monkeypatch, tmp_path):
        assert db.get_db_path() == db_path
        other = tmp_path / "other.db"
        monkeypatch.setenv("DB_PATH", str(other))
        assert db.get_db_path() == other

    def test_default_path_is_repo_db_dir(self, monkeypatch):
        monkeypatch.delenv("DB_PATH", raising=False)
        assert db.get_db_path() == DEFAULT_DB_PATH
        assert DEFAULT_DB_PATH.parent.name == "db"
        assert (DEFAULT_DB_PATH.parents[1] / "backend").is_dir()


class TestInit:
    def test_creates_tables(self, db_path):
        db.init_db()
        assert TABLES <= _tables(db_path)

    def test_explicit_path_and_parent_dir_creation(self, tmp_path):
        path = tmp_path / "nested" / "dir" / "x.db"
        db.init_db(path)
        assert path.exists()
        assert TABLES <= _tables(path)

    def test_seed_data(self):
        db.init_db()
        assert db.get_cash() == 10000.0
        assert db.get_watchlist() == [
            "AAPL",
            "GOOGL",
            "MSFT",
            "AMZN",
            "TSLA",
            "NVDA",
            "META",
            "JPM",
            "V",
            "NFLX",
        ]
        assert db.get_positions() == []
        assert db.get_trades() == []
        assert db.get_snapshots() == []
        assert db.get_chat_messages() == []

    def test_idempotent(self, db_path):
        db.init_db()
        db.init_db()
        db.init_db(db_path)
        assert len(db.get_watchlist()) == 10
        with sqlite3.connect(db_path) as conn:
            assert conn.execute("SELECT COUNT(*) FROM users_profile").fetchone()[0] == 1

    def test_reinit_preserves_user_data(self):
        db.init_db()
        db.apply_trade("AAPL", "buy", 1, 100)
        db.remove_from_watchlist("NFLX")
        db.init_db()
        assert db.get_cash() == 9900.0
        assert "NFLX" not in db.get_watchlist()
        assert db.get_position("AAPL") is not None

    def test_emptied_watchlist_is_not_reseeded(self):
        for t in db.get_watchlist():
            db.remove_from_watchlist(t)
        db.init_db()
        assert db.get_watchlist() == []

    def test_lazy_init_on_first_call(self, db_path):
        assert not db_path.exists()
        assert db.get_cash() == 10000.0
        assert db_path.exists()

    def test_lazy_init_recreates_deleted_file(self, db_path):
        db.get_cash()
        db_path.unlink()
        for suffix in ("-wal", "-shm"):
            db_path.with_name(db_path.name + suffix).unlink(missing_ok=True)
        assert len(db.get_watchlist()) == 10


class TestPragmas:
    def test_wal_and_busy_timeout(self):
        with connect() as conn:
            assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
            assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000

    def test_user_id_column_everywhere(self, db_path):
        db.init_db()
        with sqlite3.connect(db_path) as conn:
            for table in TABLES - {"users_profile"}:
                cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
                assert "user_id" in cols, table
