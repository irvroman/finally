"""FastAPI routes for the chat assistant."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter
from pydantic import BaseModel, StringConstraints

from app import db

from .chat import handle_chat

if TYPE_CHECKING:
    from app.services import TradingService

HISTORY_API_LIMIT = 50


class ChatRequest(BaseModel):
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


def create_chat_router(get_service: Callable[[], TradingService]) -> APIRouter:
    router = APIRouter(prefix="/api/chat", tags=["chat"])

    @router.post("")
    async def post_chat(body: ChatRequest) -> dict:
        return await handle_chat(body.message, get_service())

    @router.get("/history")
    async def get_chat_history() -> dict:
        return {"messages": db.get_chat_messages(limit=HISTORY_API_LIMIT)}

    return router
