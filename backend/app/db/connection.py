"""SQLite connection handling, lazy schema creation, and seed data."""

from __future__ import annotations

import os
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

DEFAULT_USER = "default"
DEFAULT_CASH = 10000.0
DEFAULT_TICKERS = ["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "JPM", "V", "NFLX"]

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
DEFAULT_DB_PATH = Path(__file__).resolve().parents[3] / "db" / "finally.db"

_initialized: set[Path] = set()
_init_lock = Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def get_db_path() -> Path:
    """Return the SQLite file path, honouring DB_PATH at call time."""
    env = os.environ.get("DB_PATH")
    return Path(env) if env else DEFAULT_DB_PATH


def _open(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None: autocommit; transactions are explicit via BEGIN.
    conn = sqlite3.connect(path, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(db_path: str | Path | None = None) -> None:
    """Create tables and seed default data if missing. Safe to call repeatedly."""
    path = Path(db_path) if db_path is not None else get_db_path()
    conn = _open(path)
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.execute("BEGIN IMMEDIATE")
        created = conn.execute(
            "INSERT OR IGNORE INTO users_profile (id, cash_balance, created_at) VALUES (?, ?, ?)",
            (DEFAULT_USER, DEFAULT_CASH, now_iso()),
        ).rowcount
        # Seed the watchlist only alongside a brand-new profile, so a user who
        # empties their watchlist doesn't get the defaults back on restart.
        if created:
            ts = now_iso()
            conn.executemany(
                "INSERT OR IGNORE INTO watchlist (id, user_id, ticker, added_at) VALUES (?, ?, ?, ?)",
                [(new_id(), DEFAULT_USER, t, ts) for t in DEFAULT_TICKERS],
            )
        conn.execute("COMMIT")
    finally:
        conn.close()
    with _init_lock:
        _initialized.add(path.resolve())


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Yield a short-lived connection to the current DB, initialising it lazily."""
    path = get_db_path()
    resolved = path.resolve()
    if resolved not in _initialized or not path.exists():
        init_db(path)
    conn = _open(path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Yield a connection inside a write transaction (commit on success, rollback on error)."""
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")
