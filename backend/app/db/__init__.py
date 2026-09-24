"""SQLite persistence layer for FinAlly (see planning/TEAM_CONTRACT.md §3.1)."""

from .connection import DEFAULT_TICKERS, get_db_path, init_db
from .repository import (
    InsufficientFunds,
    InsufficientShares,
    add_chat_message,
    add_to_watchlist,
    apply_trade,
    get_cash,
    get_chat_messages,
    get_position,
    get_positions,
    get_snapshots,
    get_trades,
    get_watchlist,
    record_snapshot,
    remove_from_watchlist,
)

__all__ = [
    "DEFAULT_TICKERS",
    "InsufficientFunds",
    "InsufficientShares",
    "add_chat_message",
    "add_to_watchlist",
    "apply_trade",
    "get_cash",
    "get_chat_messages",
    "get_db_path",
    "get_position",
    "get_positions",
    "get_snapshots",
    "get_trades",
    "get_watchlist",
    "init_db",
    "record_snapshot",
    "remove_from_watchlist",
]
