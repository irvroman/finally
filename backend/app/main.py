"""FastAPI application entry point.

Run from backend/:  uv run uvicorn app.main:app --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import db
from app.api import health_router, portfolio_router, watchlist_router
from app.market import (
    MarketDataSource,
    PriceCache,
    create_market_data_source,
    create_stream_router,
)
from app.services import TradingService

logger = logging.getLogger(__name__)

# Repo-root .env; never overrides variables already set in the environment.
load_dotenv(find_dotenv(usecwd=True) or Path(__file__).resolve().parents[2] / ".env")

SNAPSHOT_INTERVAL_SECONDS = 30.0
DEFAULT_STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


async def _snapshot_loop(service: TradingService, interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            await service.record_snapshot()
        except Exception:
            logger.exception("Portfolio snapshot failed")


def _chat_router(get_service: Callable[[], TradingService]):
    try:
        from app.llm.router import create_chat_router
    except ModuleNotFoundError as exc:
        # Only tolerate the llm module being absent, not broken imports inside it.
        if exc.name not in ("app.llm", "app.llm.router"):
            raise
        logger.warning("app.llm.router not available; /api/chat is disabled")
        return None
    return create_chat_router(get_service)


def create_app(
    source_factory: Callable[[PriceCache], MarketDataSource] = create_market_data_source,
    snapshot_interval: float = SNAPSHOT_INTERVAL_SECONDS,
) -> FastAPI:
    price_cache = PriceCache()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.init_db()
        source = source_factory(price_cache)
        service = TradingService(price_cache, source)
        app.state.price_cache = price_cache
        app.state.market_source = source
        app.state.trading_service = service

        await source.start(service.tracked_tickers())
        await service.record_snapshot()
        snapshot_task = asyncio.create_task(
            _snapshot_loop(service, snapshot_interval), name="portfolio-snapshots"
        )
        try:
            yield
        finally:
            snapshot_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await snapshot_task
            await source.stop()

    app = FastAPI(title="FinAlly", lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(portfolio_router)
    app.include_router(watchlist_router)
    app.include_router(create_stream_router(price_cache))

    chat_router = _chat_router(lambda: app.state.trading_service)
    if chat_router is not None:
        app.include_router(chat_router)

    # Static frontend last, so /api routes take precedence.
    static_dir = Path(os.environ.get("STATIC_DIR") or DEFAULT_STATIC_DIR)
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    else:
        logger.info("Static dir %s not found; serving API only", static_dir)

    return app


app = create_app()
