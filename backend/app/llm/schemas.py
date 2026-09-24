"""Structured output schema for the FinAlly chat assistant."""

from typing import Literal

from pydantic import BaseModel, Field


class TradeAction(BaseModel):
    """A market order the assistant wants to execute."""

    ticker: str = Field(description="Ticker symbol, e.g. AAPL")
    side: Literal["buy", "sell"]
    quantity: float = Field(description="Number of shares (fractional allowed, must be > 0)")


class WatchlistAction(BaseModel):
    """A watchlist modification the assistant wants to make."""

    ticker: str = Field(description="Ticker symbol, e.g. PYPL")
    action: Literal["add", "remove"]


class LLMResponse(BaseModel):
    """The complete structured response from the LLM."""

    message: str = Field(description="Conversational reply shown to the user")
    trades: list[TradeAction] = Field(
        default_factory=list, description="Trades to execute now; empty if none"
    )
    watchlist_changes: list[WatchlistAction] = Field(
        default_factory=list, description="Watchlist changes to apply now; empty if none"
    )
