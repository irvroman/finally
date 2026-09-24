"""Chat orchestration: prompt the LLM, auto-execute its actions, persist the conversation."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from app import db

from .client import LLMResponseError, call_llm
from .mock import is_mock_enabled, mock_response
from .prompts import build_messages, format_portfolio_context
from .schemas import LLMResponse

if TYPE_CHECKING:
    from app.services import TradingService

logger = logging.getLogger(__name__)

HISTORY_LIMIT = 20
FAILURE_MESSAGE = "Sorry — I couldn't reach the AI service right now. Please try again."


def _error_reason(exc: Exception) -> str:
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "AI service timed out"
    if isinstance(exc, LLMResponseError):
        return str(exc)
    detail = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    reason = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
    return reason[:200]


def _failure_response(reason: str) -> dict:
    return {"message": FAILURE_MESSAGE, "trades": [], "watchlist_changes": [], "error": reason}


async def _get_reply(user_message: str, history: list[dict], service: TradingService) -> LLMResponse:
    portfolio = service.get_portfolio()
    if is_mock_enabled():
        return mock_response(user_message, float(portfolio.get("total_value") or 0.0))
    context = format_portfolio_context(portfolio, service.get_watchlist())
    return await call_llm(build_messages(user_message, context, history))


async def _apply_watchlist_changes(reply: LLMResponse, service: TradingService) -> list[dict]:
    results = []
    for change in reply.watchlist_changes:
        ticker = change.ticker.strip().upper()
        result = {"ticker": ticker, "action": change.action}
        try:
            if change.action == "add":
                await service.add_to_watchlist(ticker)
                result["status"] = "executed"
            elif await service.remove_from_watchlist(ticker):
                result["status"] = "executed"
            else:
                result.update(status="failed", error=f"{ticker} is not on your watchlist")
        except Exception as exc:  # TradeError carries a user-facing message
            result.update(status="failed", error=str(exc) or type(exc).__name__)
        results.append(result)
    return results


async def _apply_trades(reply: LLMResponse, service: TradingService) -> list[dict]:
    results = []
    for trade in reply.trades:
        ticker = trade.ticker.strip().upper()
        result = {"ticker": ticker, "side": trade.side, "quantity": trade.quantity}
        try:
            row = await service.execute_trade(ticker, trade.side, trade.quantity)
            result.update(
                ticker=row.get("ticker", ticker),
                quantity=row.get("quantity", trade.quantity),
                status="executed",
                price=row.get("price"),
            )
        except Exception as exc:  # TradeError carries a user-facing message
            result.update(status="failed", error=str(exc) or type(exc).__name__)
        results.append(result)
    return results


async def handle_chat(user_message: str, service: TradingService) -> dict:
    """Process one user chat message and return the POST /api/chat response body."""
    history = db.get_chat_messages(limit=HISTORY_LIMIT)
    db.add_chat_message("user", user_message)

    try:
        reply = await _get_reply(user_message, history, service)
    except Exception as exc:
        logger.warning("LLM call failed: %s", exc, exc_info=True)
        return _failure_response(_error_reason(exc))

    # Contract §1.12: watchlist changes first, then trades; each action independent.
    watchlist_results = await _apply_watchlist_changes(reply, service)
    trade_results = await _apply_trades(reply, service)

    actions = {"trades": trade_results, "watchlist_changes": watchlist_results}
    db.add_chat_message("assistant", reply.message, actions=actions)
    return {"message": reply.message, **actions}
