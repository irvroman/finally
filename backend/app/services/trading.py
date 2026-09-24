"""Trading service: trade execution, watchlist management, portfolio valuation.

Used by both the REST API and the LLM chat flow. It owns the rule that the
market data source tracks the union of the watchlist and open positions
(TEAM_CONTRACT §1.1-1.2).
"""

from __future__ import annotations

import asyncio
import logging
import math
import re

from app import db
from app.market import MarketDataSource, PriceCache

logger = logging.getLogger(__name__)

TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
QTY_EPSILON = 1e-9


class TradeError(Exception):
    """A trade or watchlist request failed validation. The message is user-facing."""


def normalize_ticker(ticker: object) -> str:
    """Uppercase and strip a ticker, raising TradeError if it isn't a valid symbol."""
    if not isinstance(ticker, str):
        raise TradeError("Ticker must be a string")
    symbol = ticker.strip().upper()
    if not TICKER_RE.match(symbol):
        raise TradeError(f"Invalid ticker: {ticker.strip()!r}")
    return symbol


def _normalize_quantity(quantity: object) -> float:
    try:
        qty = float(quantity)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise TradeError("Quantity must be a number") from None
    if not math.isfinite(qty):
        raise TradeError("Quantity must be a finite number")
    qty = round(qty, 4)
    if qty <= 0:
        raise TradeError("Quantity must be greater than 0")
    return qty


def _r(value: float, ndigits: int) -> float:
    """round() that never yields -0.0."""
    return round(value, ndigits) + 0.0


def _fmt_qty(qty: float) -> str:
    return f"{qty:g}"


class TradingService:
    def __init__(self, price_cache: PriceCache, source: MarketDataSource) -> None:
        self._cache = price_cache
        self._source = source
        # Serialises trades and watchlist changes so ticker tracking decisions
        # (add/remove from the source) never interleave.
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ tracking

    def tracked_tickers(self) -> list[str]:
        """Watchlist ∪ open positions, watchlist order first."""
        tickers = list(db.get_watchlist())
        for pos in db.get_positions():
            if pos["ticker"] not in tickers:
                tickers.append(pos["ticker"])
        return tickers

    async def _untrack_if_unused(self, ticker: str) -> None:
        if ticker in db.get_watchlist() or db.get_position(ticker) is not None:
            return
        await self._source.remove_ticker(ticker)

    async def _ensure_tracked(self, ticker: str) -> None:
        if ticker not in self._source.get_tickers():
            await self._source.add_ticker(ticker)

    # ------------------------------------------------------------------ trading

    async def execute_trade(self, ticker: str, side: str, quantity: float) -> dict:
        """Execute a market order at the cached price. Returns the trade row."""
        symbol = normalize_ticker(ticker)
        side_norm = side.strip().lower() if isinstance(side, str) else ""
        if side_norm not in ("buy", "sell"):
            raise TradeError("Side must be 'buy' or 'sell'")
        qty = _normalize_quantity(quantity)

        async with self._lock:
            await self._ensure_tracked(symbol)
            try:
                price = self._cache.get_price(symbol)
                if price is None:
                    raise TradeError(f"No price available for {symbol}")
                trade = self._apply(symbol, side_norm, qty, price)
            finally:
                # Drops the ticker again if the trade failed on an unwatched
                # symbol, or if a sell closed the last position on one.
                await self._untrack_if_unused(symbol)

        logger.info("Trade executed: %s %s %s @ %.2f", side_norm, _fmt_qty(qty), symbol, price)
        await self.record_snapshot()
        return trade

    def _apply(self, symbol: str, side: str, qty: float, price: float) -> dict:
        try:
            return db.apply_trade(symbol, side, qty, price)
        except db.InsufficientFunds:
            cash = db.get_cash()
            raise TradeError(
                f"Insufficient cash: buying {_fmt_qty(qty)} {symbol} at ${price:,.2f} "
                f"costs ${qty * price:,.2f} but only ${cash:,.2f} is available"
            ) from None
        except db.InsufficientShares:
            pos = db.get_position(symbol)
            held = pos["quantity"] if pos else 0.0
            raise TradeError(
                f"Insufficient shares: cannot sell {_fmt_qty(qty)} {symbol}, "
                f"you hold {_fmt_qty(round(held, 4))}"
            ) from None
        except ValueError as exc:
            raise TradeError(str(exc)) from None

    # ------------------------------------------------------------------ watchlist

    async def add_to_watchlist(self, ticker: str) -> dict:
        symbol = normalize_ticker(ticker)
        async with self._lock:
            db.add_to_watchlist(symbol)
            await self._ensure_tracked(symbol)
        return self._watchlist_item(symbol)

    async def remove_from_watchlist(self, ticker: str) -> bool:
        try:
            symbol = normalize_ticker(ticker)
        except TradeError:
            return False
        async with self._lock:
            removed = db.remove_from_watchlist(symbol)
            if removed:
                await self._untrack_if_unused(symbol)
        return removed

    def is_on_watchlist(self, ticker: str) -> bool:
        return ticker in db.get_watchlist()

    def get_watchlist(self) -> list[dict]:
        return [self._watchlist_item(t) for t in db.get_watchlist()]

    def _watchlist_item(self, ticker: str) -> dict:
        update = self._cache.get(ticker)
        if update is None:
            return {
                "ticker": ticker,
                "price": None,
                "previous_price": None,
                "change": None,
                "change_percent": None,
                "direction": None,
                "timestamp": None,
            }
        return update.to_dict()

    # ------------------------------------------------------------------ portfolio

    def get_portfolio(self) -> dict:
        cash = db.get_cash()
        rows = []
        positions_value = 0.0
        cost_basis = 0.0
        for pos in db.get_positions():
            qty = pos["quantity"]
            avg = pos["avg_cost"]
            price = self._cache.get_price(pos["ticker"])
            if price is None:
                price = avg
            market_value = qty * price
            pnl = (price - avg) * qty
            positions_value += market_value
            cost_basis += qty * avg
            rows.append(
                {
                    "ticker": pos["ticker"],
                    "quantity": round(qty, 4),
                    "avg_cost": avg,
                    "current_price": price,
                    "market_value": market_value,
                    "unrealized_pnl": pnl,
                    "pnl_percent": (price - avg) / avg * 100 if avg else 0.0,
                }
            )

        total_value = cash + positions_value
        for row in rows:
            row["weight"] = _r(row["market_value"] / total_value, 4) if total_value else 0.0
            row["avg_cost"] = _r(row["avg_cost"], 2)
            row["current_price"] = _r(row["current_price"], 2)
            row["market_value"] = _r(row["market_value"], 2)
            row["unrealized_pnl"] = _r(row["unrealized_pnl"], 2)
            row["pnl_percent"] = _r(row["pnl_percent"], 2)

        return {
            "cash_balance": _r(cash, 2),
            "total_value": _r(total_value, 2),
            "positions_value": _r(positions_value, 2),
            "unrealized_pnl": _r(positions_value - cost_basis, 2),
            "positions": rows,
        }

    def total_value(self) -> float:
        """Unrounded cash + Σ qty × price (avg_cost fallback when unpriced)."""
        total = db.get_cash()
        for pos in db.get_positions():
            price = self._cache.get_price(pos["ticker"])
            total += pos["quantity"] * (price if price is not None else pos["avg_cost"])
        return total

    def get_history(self) -> list[dict]:
        return [
            {"total_value": _r(s["total_value"], 2), "recorded_at": s["recorded_at"]}
            for s in db.get_snapshots()
        ]

    async def record_snapshot(self) -> dict:
        return db.record_snapshot(self.total_value())
