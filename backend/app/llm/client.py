"""LLM call via LiteLLM -> OpenRouter (Cerebras provider) with structured outputs."""

from __future__ import annotations

import asyncio
import json
import re

from pydantic import ValidationError

from .schemas import LLMResponse

MODEL = "openrouter/openai/gpt-oss-120b"
EXTRA_BODY = {"provider": {"order": ["cerebras"]}}
TIMEOUT_SECONDS = 30.0

_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL | re.IGNORECASE)


class LLMResponseError(Exception):
    """The LLM returned something that can't be parsed into an LLMResponse."""


def parse_llm_response(content: str | None) -> LLMResponse:
    """Parse raw model output into an LLMResponse, tolerating code fences and surrounding text."""
    if content is None or not content.strip():
        raise LLMResponseError("Empty response from AI service")

    text = content.strip()
    fenced = _FENCE_RE.match(text)
    if fenced:
        text = fenced.group(1)

    try:
        return LLMResponse.model_validate_json(text)
    except ValidationError as first_error:
        # Fall back to the outermost {...} block, in case the model wrapped the JSON in prose.
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            try:
                return LLMResponse.model_validate(json.loads(text[start : end + 1]))
            except (ValueError, ValidationError):
                pass
        raise LLMResponseError("Malformed response from AI service") from first_error


def _call_llm_sync(messages: list[dict]) -> str | None:
    from litellm import completion  # imported lazily: litellm is slow to import

    response = completion(
        model=MODEL,
        messages=messages,
        response_format=LLMResponse,
        reasoning_effort="low",
        extra_body=EXTRA_BODY,
        timeout=TIMEOUT_SECONDS,
    )
    return response.choices[0].message.content


async def call_llm(messages: list[dict]) -> LLMResponse:
    """Call the LLM off the event loop with a hard timeout, and parse the result."""
    content = await asyncio.wait_for(
        asyncio.to_thread(_call_llm_sync, messages), timeout=TIMEOUT_SECONDS
    )
    return parse_llm_response(content)
