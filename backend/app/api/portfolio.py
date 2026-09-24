"""Portfolio endpoints: valuation, trade execution, value history."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.services import TradeError, TradingService

from .deps import get_trading_service

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


class TradeRequest(BaseModel):
    ticker: str
    quantity: float
    side: str


@router.get("")
def get_portfolio(service: TradingService = Depends(get_trading_service)) -> dict:
    return service.get_portfolio()


@router.post("/trade")
async def execute_trade(
    body: TradeRequest, service: TradingService = Depends(get_trading_service)
) -> dict:
    try:
        trade = await service.execute_trade(body.ticker, body.side, body.quantity)
    except TradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return {"trade": trade, "portfolio": service.get_portfolio()}


@router.get("/history")
def get_history(service: TradingService = Depends(get_trading_service)) -> dict:
    return {"snapshots": service.get_history()}
