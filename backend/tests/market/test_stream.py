"""Tests for the SSE market price stream."""

import asyncio
import json
from dataclasses import dataclass

import pytest

from app.market.cache import PriceCache
from app.market.stream import _generate_events, create_stream_router


@dataclass
class FakeClient:
    host: str = "127.0.0.1"


class FakeRequest:
    def __init__(self, disconnected: bool = False) -> None:
        self.client = FakeClient()
        self.disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self.disconnected


@pytest.mark.asyncio
async def test_stream_starts_with_retry_directive_and_price_payload():
    cache = PriceCache()
    cache.update("AAPL", 190.50, timestamp=123.0)
    events = _generate_events(cache, FakeRequest(), interval=0)

    assert await anext(events) == "retry: 1000\n\n"
    event = await anext(events)
    prefix, payload = event.removeprefix("data: ").split("\n\n", 1)
    assert json.loads(prefix)["AAPL"] == {
        "ticker": "AAPL",
        "price": 190.5,
        "previous_price": 190.5,
        "timestamp": 123.0,
        "change": 0.0,
        "change_percent": 0.0,
        "direction": "flat",
    }
    assert payload == ""
    await events.aclose()


@pytest.mark.asyncio
async def test_stream_emits_after_cache_version_change():
    cache = PriceCache()
    cache.update("AAPL", 190.50)
    events = _generate_events(cache, FakeRequest(), interval=0)

    await anext(events)
    await anext(events)

    cache.update("AAPL", 191.00)
    event = await anext(events)
    assert '"price": 191.0' in event
    await events.aclose()


@pytest.mark.asyncio
async def test_stream_ends_when_request_is_disconnected():
    events = _generate_events(PriceCache(), FakeRequest(disconnected=True), interval=0)

    assert await anext(events) == "retry: 1000\n\n"
    with pytest.raises(StopAsyncIteration):
        await anext(events)


@pytest.mark.asyncio
async def test_stream_handles_cancellation():
    events = _generate_events(PriceCache(), FakeRequest(), interval=0)
    await anext(events)
    task = asyncio.create_task(anext(events))
    await asyncio.sleep(0)
    task.cancel()

    with pytest.raises(StopAsyncIteration):
        await task
    await events.aclose()


def test_stream_router_factory_returns_independent_routers():
    first = create_stream_router(PriceCache())
    second = create_stream_router(PriceCache())

    assert first is not second
    assert len(first.routes) == len(second.routes) == 1
