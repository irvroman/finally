"""System prompt and message construction for the chat assistant."""

from __future__ import annotations

import json

SYSTEM_PROMPT = """You are FinAlly, an AI trading assistant inside a simulated trading workstation.
The user trades a virtual portfolio with fake money; market orders fill instantly at the current price, with no fees.

Your job:
- Analyze the user's portfolio: composition, risk concentration, and unrealized P&L.
- Suggest trades with brief, data-driven reasoning.
- Execute trades when the user asks for them or agrees to your suggestion, by listing them in "trades".
- Manage the watchlist proactively by listing changes in "watchlist_changes".
- Be concise. Use the numbers from the portfolio context; never invent prices.

Rules:
- Always respond with valid JSON matching the schema: {"message": str, "trades": [{"ticker", "side": "buy"|"sell", "quantity"}], "watchlist_changes": [{"ticker", "action": "add"|"remove"}]}.
- Use empty lists when there are no actions. Only include trades the user asked for or agreed to.
- Quantities are shares (fractional allowed, > 0). Tickers are uppercase symbols.
- Buys need enough cash (quantity * price <= cash); sells need enough shares. Don't propose trades that clearly violate this.
- Your "message" should describe what you're doing; the system reports execution results to the user separately."""


def _money(value) -> str:
    return "n/a" if value is None else f"${value:,.2f}"


def format_portfolio_context(portfolio: dict, watchlist: list[dict]) -> str:
    """Render the portfolio and watchlist as compact text for the LLM."""
    lines = [
        "Current portfolio:",
        f"- Cash: {_money(portfolio.get('cash_balance'))}",
        f"- Total value: {_money(portfolio.get('total_value'))}",
        f"- Positions value: {_money(portfolio.get('positions_value'))}",
        f"- Unrealized P&L: {_money(portfolio.get('unrealized_pnl'))}",
    ]
    positions = portfolio.get("positions") or []
    if positions:
        lines.append("Positions:")
        for p in positions:
            weight = p.get("weight")
            pnl_pct = p.get("pnl_percent")
            lines.append(
                f"- {p.get('ticker')}: {p.get('quantity')} sh @ avg {_money(p.get('avg_cost'))}, "
                f"now {_money(p.get('current_price'))}, value {_money(p.get('market_value'))}, "
                f"P&L {_money(p.get('unrealized_pnl'))}"
                + (f" ({pnl_pct:+.2f}%)" if pnl_pct is not None else "")
                + (f", weight {weight * 100:.1f}%" if weight is not None else "")
            )
    else:
        lines.append("Positions: none")

    if watchlist:
        lines.append("Watchlist (live prices):")
        for w in watchlist:
            change_pct = w.get("change_percent")
            lines.append(
                f"- {w.get('ticker')}: {_money(w.get('price'))}"
                + (f" ({change_pct:+.2f}% last tick)" if change_pct is not None else "")
            )
    else:
        lines.append("Watchlist: empty")
    return "\n".join(lines)


def _history_content(msg: dict) -> str:
    content = msg.get("content") or ""
    actions = msg.get("actions")
    if msg.get("role") == "assistant" and actions:
        content += "\n[Executed actions: " + json.dumps(actions, separators=(",", ":")) + "]"
    return content


def build_messages(user_message: str, context: str, history: list[dict]) -> list[dict]:
    """System prompt + portfolio context, then prior conversation (oldest first), then the new message."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": context},
    ]
    for msg in history:
        if msg.get("role") in ("user", "assistant"):
            messages.append({"role": msg["role"], "content": _history_content(msg)})
    messages.append({"role": "user", "content": user_message})
    return messages
