"""Deterministic mock responses for LLM_MOCK=true (grammar fixed by TEAM_CONTRACT.md §3.3)."""

from __future__ import annotations

import os
import re

from .schemas import LLMResponse, TradeAction, WatchlistAction

_TICKER = r"([A-Za-z][A-Za-z0-9.]*)"
_QTY = r"(\d+(?:\.\d+)?|\.\d+)"

_BUY_RE = re.compile(rf"\bbuy\s+{_QTY}\s+{_TICKER}", re.IGNORECASE)
_SELL_RE = re.compile(rf"\bsell\s+{_QTY}\s+{_TICKER}", re.IGNORECASE)
_ADD_RE = re.compile(rf"\b(?:add|watch)\s+{_TICKER}", re.IGNORECASE)
_REMOVE_RE = re.compile(rf"\bremove\s+{_TICKER}", re.IGNORECASE)


def is_mock_enabled() -> bool:
    return os.environ.get("LLM_MOCK", "").strip().lower() in {"true", "1", "yes"}


def _clean_ticker(raw: str) -> str:
    return raw.rstrip(".").upper()


def mock_response(user_message: str, total_value: float) -> LLMResponse:
    """Return the deterministic mock reply for a user message. First matching rule wins."""
    if m := _BUY_RE.search(user_message):
        qty, ticker = m.group(1), _clean_ticker(m.group(2))
        return LLMResponse(
            message=f"Buying {qty} shares of {ticker}.",
            trades=[TradeAction(ticker=ticker, side="buy", quantity=float(qty))],
        )
    if m := _SELL_RE.search(user_message):
        qty, ticker = m.group(1), _clean_ticker(m.group(2))
        return LLMResponse(
            message=f"Selling {qty} shares of {ticker}.",
            trades=[TradeAction(ticker=ticker, side="sell", quantity=float(qty))],
        )
    if m := _ADD_RE.search(user_message):
        ticker = _clean_ticker(m.group(1))
        return LLMResponse(
            message=f"Adding {ticker} to your watchlist.",
            watchlist_changes=[WatchlistAction(ticker=ticker, action="add")],
        )
    if m := _REMOVE_RE.search(user_message):
        ticker = _clean_ticker(m.group(1))
        return LLMResponse(
            message=f"Removing {ticker} from your watchlist.",
            watchlist_changes=[WatchlistAction(ticker=ticker, action="remove")],
        )
    return LLMResponse(
        message=f"This is a mock response from FinAlly. Your portfolio is worth ${total_value:.2f}."
    )
