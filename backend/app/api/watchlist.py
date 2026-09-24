"""Watchlist endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services import TradeError, TradingService, normalize_ticker

from .deps import get_trading_service

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


class WatchlistAddRequest(BaseModel):
    ticker: str


@router.get("")
def get_watchlist(service: TradingService = Depends(get_trading_service)) -> dict:
    return {"tickers": service.get_watchlist()}


@router.post("")
async def add_ticker(
    body: WatchlistAddRequest, service: TradingService = Depends(get_trading_service)
) -> JSONResponse:
    try:
        already_present = service.is_on_watchlist(normalize_ticker(body.ticker))
        item = await service.add_to_watchlist(body.ticker)
    except TradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return JSONResponse(status_code=200 if already_present else 201, content=item)


@router.delete("/{ticker}")
async def remove_ticker(
    ticker: str, service: TradingService = Depends(get_trading_service)
) -> dict:
    if not await service.remove_from_watchlist(ticker):
        raise HTTPException(status_code=404, detail=f"{ticker.strip().upper()} is not on the watchlist")
    return {"removed": ticker.strip().upper()}
