"""Data access functions. Synchronous sqlite3, plain dicts in and out."""

from __future__ import annotations

import json
import sqlite3

from .connection import DEFAULT_CASH, DEFAULT_USER, connect, new_id, now_iso, transaction

EPSILON = 1e-9


class InsufficientFunds(Exception):  # noqa: N818 (name fixed by TEAM_CONTRACT)
    """A buy costs more than the available cash."""


class InsufficientShares(Exception):  # noqa: N818 (name fixed by TEAM_CONTRACT)
    """A sell asks for more shares than are held."""


def _norm(ticker: str) -> str:
    return ticker.strip().upper()


def _ensure_profile(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO users_profile (id, cash_balance, created_at) VALUES (?, ?, ?)",
        (user_id, DEFAULT_CASH, now_iso()),
    )


# --- Cash -------------------------------------------------------------------


def get_cash(user_id: str = DEFAULT_USER) -> float:
    with connect() as conn:
        row = conn.execute(
            "SELECT cash_balance FROM users_profile WHERE id = ?", (user_id,)
        ).fetchone()
    return float(row["cash_balance"]) if row else DEFAULT_CASH


# --- Watchlist --------------------------------------------------------------


def get_watchlist(user_id: str = DEFAULT_USER) -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT ticker FROM watchlist WHERE user_id = ? ORDER BY added_at, rowid",
            (user_id,),
        ).fetchall()
    return [r["ticker"] for r in rows]


def add_to_watchlist(ticker: str, user_id: str = DEFAULT_USER) -> bool:
    """Add a ticker. Returns False if it was already present."""
    with transaction() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO watchlist (id, user_id, ticker, added_at) VALUES (?, ?, ?, ?)",
            (new_id(), user_id, _norm(ticker), now_iso()),
        )
        return cur.rowcount == 1


def remove_from_watchlist(ticker: str, user_id: str = DEFAULT_USER) -> bool:
    """Remove a ticker. Returns False if it was not present."""
    with transaction() as conn:
        cur = conn.execute(
            "DELETE FROM watchlist WHERE user_id = ? AND ticker = ?", (user_id, _norm(ticker))
        )
        return cur.rowcount > 0


# --- Positions & trades -----------------------------------------------------

_POSITION_COLS = "ticker, quantity, avg_cost, updated_at"
_TRADE_COLS = "id, ticker, side, quantity, price, executed_at"


def get_positions(user_id: str = DEFAULT_USER) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            f"SELECT {_POSITION_COLS} FROM positions WHERE user_id = ? ORDER BY ticker",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_position(ticker: str, user_id: str = DEFAULT_USER) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            f"SELECT {_POSITION_COLS} FROM positions WHERE user_id = ? AND ticker = ?",
            (user_id, _norm(ticker)),
        ).fetchone()
    return dict(row) if row else None


def apply_trade(
    ticker: str, side: str, quantity: float, price: float, user_id: str = DEFAULT_USER
) -> dict:
    """Execute a market order atomically: cash, position and trade log in one transaction.

    Raises ValueError for bad input, InsufficientFunds / InsufficientShares on validation.
    Returns the trade row.
    """
    ticker = _norm(ticker)
    side = side.strip().lower()
    quantity = float(quantity)
    price = float(price)
    if side not in ("buy", "sell"):
        raise ValueError(f"Invalid side: {side!r}")
    if not ticker:
        raise ValueError("Ticker is required")
    if not quantity > 0:
        raise ValueError("Quantity must be greater than 0")
    if not price > 0:
        raise ValueError("Price must be greater than 0")

    ts = now_iso()
    with transaction() as conn:
        _ensure_profile(conn, user_id)
        cash = conn.execute(
            "SELECT cash_balance FROM users_profile WHERE id = ?", (user_id,)
        ).fetchone()["cash_balance"]
        pos = conn.execute(
            "SELECT quantity, avg_cost FROM positions WHERE user_id = ? AND ticker = ?",
            (user_id, ticker),
        ).fetchone()
        held = pos["quantity"] if pos else 0.0
        cost = quantity * price

        if side == "buy":
            if cost > cash + EPSILON:
                raise InsufficientFunds(f"Insufficient cash: need ${cost:,.2f}, have ${cash:,.2f}")
            new_qty = held + quantity
            new_avg = (held * pos["avg_cost"] + cost) / new_qty if pos else price
            conn.execute(
                "INSERT INTO positions (id, user_id, ticker, quantity, avg_cost, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (user_id, ticker) DO UPDATE SET "
                "quantity = excluded.quantity, avg_cost = excluded.avg_cost, "
                "updated_at = excluded.updated_at",
                (new_id(), user_id, ticker, new_qty, new_avg, ts),
            )
            cash_delta = -cost
        else:
            if quantity > held + EPSILON:
                raise InsufficientShares(
                    f"Insufficient shares of {ticker}: want to sell {quantity:g}, hold {held:g}"
                )
            new_qty = held - quantity
            if new_qty <= EPSILON:
                conn.execute(
                    "DELETE FROM positions WHERE user_id = ? AND ticker = ?", (user_id, ticker)
                )
            else:
                conn.execute(
                    "UPDATE positions SET quantity = ?, updated_at = ? "
                    "WHERE user_id = ? AND ticker = ?",
                    (new_qty, ts, user_id, ticker),
                )
            cash_delta = cost

        conn.execute(
            "UPDATE users_profile SET cash_balance = cash_balance + ? WHERE id = ?",
            (cash_delta, user_id),
        )
        trade = {
            "id": new_id(),
            "ticker": ticker,
            "side": side,
            "quantity": quantity,
            "price": price,
            "executed_at": ts,
        }
        conn.execute(
            "INSERT INTO trades (id, user_id, ticker, side, quantity, price, executed_at) "
            "VALUES (:id, :user_id, :ticker, :side, :quantity, :price, :executed_at)",
            {**trade, "user_id": user_id},
        )
    return trade


def get_trades(limit: int = 50, user_id: str = DEFAULT_USER) -> list[dict]:
    """Most recent trades first."""
    with connect() as conn:
        rows = conn.execute(
            f"SELECT {_TRADE_COLS} FROM trades WHERE user_id = ? "
            "ORDER BY executed_at DESC, rowid DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# --- Portfolio snapshots ----------------------------------------------------


def record_snapshot(total_value: float, user_id: str = DEFAULT_USER) -> dict:
    snap = {"id": new_id(), "total_value": float(total_value), "recorded_at": now_iso()}
    with transaction() as conn:
        conn.execute(
            "INSERT INTO portfolio_snapshots (id, user_id, total_value, recorded_at) "
            "VALUES (:id, :user_id, :total_value, :recorded_at)",
            {**snap, "user_id": user_id},
        )
    return snap


def get_snapshots(limit: int = 500, user_id: str = DEFAULT_USER) -> list[dict]:
    """The most recent `limit` snapshots, ordered oldest to newest."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, total_value, recorded_at FROM portfolio_snapshots WHERE user_id = ? "
            "ORDER BY recorded_at DESC, rowid DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# --- Chat -------------------------------------------------------------------


def add_chat_message(
    role: str, content: str, actions: dict | None = None, user_id: str = DEFAULT_USER
) -> dict:
    if role not in ("user", "assistant"):
        raise ValueError(f"Invalid role: {role!r}")
    msg = {
        "id": new_id(),
        "role": role,
        "content": content,
        "actions": actions,
        "created_at": now_iso(),
    }
    with transaction() as conn:
        conn.execute(
            "INSERT INTO chat_messages (id, user_id, role, content, actions, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                msg["id"],
                user_id,
                role,
                content,
                json.dumps(actions) if actions is not None else None,
                msg["created_at"],
            ),
        )
    return msg


def get_chat_messages(limit: int = 20, user_id: str = DEFAULT_USER) -> list[dict]:
    """The most recent `limit` messages, ordered oldest to newest, with actions parsed."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, role, content, actions, created_at FROM chat_messages "
            "WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    messages = []
    for r in reversed(rows):
        m = dict(r)
        m["actions"] = json.loads(m["actions"]) if m["actions"] is not None else None
        messages.append(m)
    return messages
