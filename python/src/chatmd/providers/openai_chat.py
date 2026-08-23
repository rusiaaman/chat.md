"""OpenAI chat-completions streaming client.

A port of ``src/openaiClient.ts``, backed by the official ``openai`` SDK instead of
hand-rolled HTTPS/SSE. This client is used against many non-OpenAI hosts
(OpenRouter, local servers, Azure-style gateways) so reasoning fields are read
defensively (``getattr``/extra-field fallbacks) rather than assumed to match the
SDK's typed models, since those hosts routinely send fields
(``reasoning``, ``reasoning_content``, ``reasoning_details``) the SDK does not
declare.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import AsyncIterable, AsyncIterator, Sequence
from pathlib import Path
from typing import Any

import openai
from openai import AsyncOpenAI

from ..config.model import ResolvedConfig
from ..fileio import get_mime_type, read_bytes, resolve_file_path
from ..types import (
    Content,
    ImageContent,
    MessageParam,
    ReasoningEffort,
    ReasoningFieldName,
    StreamEvent,
    TextContent,
    TextDelta,
    ThinkingContent,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    Usage,
    UsageDelta,
)
from .base import MaxTokensError, RetryableError
from .cleanup import clean_messages_for_api

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "gpt-3.5-turbo"

#: Order in which flat-text reasoning fields are checked. Providers sometimes send
#: the same reasoning in more than one of these at once; only the first hit counts.
REASONING_TEXT_FIELDS: tuple[ReasoningFieldName, ...] = (
    "reasoning_content",
    "reasoning",
    "reasoning_summary",
)


class ReasoningDetailsAccumulator:
    """Accumulates OpenRouter-style ``reasoning_details`` deltas across a turn.

    ``reasoning_details`` is the only reasoning form that can be replayed verbatim
    on a later turn (it carries provider signatures that flat reasoning text does
    not), so unlike plain text it must be merged by identity rather than
    concatenated blindly.
    """

    def __init__(self) -> None:
        self._details: list[dict[str, Any]] = []
        self._index_by_key: dict[str, int] = {}

    def process_delta(self, detail: Any) -> str:
        """Merge one detail chunk and return the text it displays, if any."""
        if not isinstance(detail, dict):
            return ""

        display = self._display_text(detail)
        key = self._key_for(detail, len(self._details))
        existing_index = self._index_by_key.get(key)

        if existing_index is None:
            self._index_by_key[key] = len(self._details)
            self._details.append(dict(detail))
            return display

        existing = self._details[existing_index]
        for field, value in detail.items():
            if field in ("text", "summary") and isinstance(value, str):
                # These fields stream incrementally; every other field is a
                # one-shot attribute that simply gets replaced.
                previous = existing.get(field)
                existing[field] = previous + value if isinstance(previous, str) else value
            elif value is not None:
                existing[field] = value
        return display

    def has_details(self) -> bool:
        return bool(self._details)

    def get_details(self) -> list[dict[str, Any]]:
        return [dict(detail) for detail in self._details]

    def _key_for(self, detail: dict[str, Any], fallback_index: int) -> str:
        detail_type = detail.get("type") if isinstance(detail.get("type"), str) else None
        detail_type = detail_type or "reasoning.unknown"

        detail_id = detail.get("id")
        if isinstance(detail_id, str) and detail_id:
            return f"{detail_type}::id::{detail_id}"

        index = detail.get("index")
        if isinstance(index, (int, float)) and not isinstance(index, bool):
            return f"{detail_type}::index::{index}"

        return f"{detail_type}::pos::{fallback_index}"

    def _display_text(self, detail: dict[str, Any]) -> str:
        text = detail.get("text")
        if isinstance(text, str):
            return text
        summary = detail.get("summary")
        if isinstance(summary, str):
            return summary
        return ""


def build_request_kwargs(
    *,
    model: str,
    system_prompt: str,
    formatted_messages: list[dict[str, Any]],
    max_tokens: int,
    reasoning_effort: ReasoningEffort | None,
) -> dict[str, Any]:
    """Assemble ``chat.completions.create`` kwargs. Pure, so tests need no client."""
    messages = [{"role": "system", "content": system_prompt}, *formatted_messages]
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        # Reasoning models bill thinking and visible output from one pool, so the
        # limit must be max_completion_tokens, not the legacy max_tokens.
        "max_completion_tokens": max_tokens,
    }
    # Ported truthiness quirk: a configured value of "none" is still sent, exactly
    # as the TS client's `if (reasoningEffort)` treats "none" as truthy.
    if reasoning_effort is not None:
        kwargs["reasoning_effort"] = reasoning_effort
    return kwargs


def _format_image(item: ImageContent, base_dir: str | Path | None) -> dict[str, Any]:
    resolved = resolve_file_path(item.path, base_dir)
    data = read_bytes(resolved)
    if data is None:
        return {"type": "text", "text": f"[Failed to load image: {item.path}]"}
    encoded = base64.b64encode(data).decode("ascii")
    mime_type = get_mime_type(resolved)
    return {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}}


def _format_content(items: Sequence[Content], base_dir: str | Path | None) -> Any:
    if all(isinstance(item, TextContent) for item in items):
        return "\n\n".join(item.value for item in items if isinstance(item, TextContent))

    parts: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, TextContent):
            parts.append({"type": "text", "text": item.value})
        elif isinstance(item, ImageContent):
            parts.append(_format_image(item, base_dir))
    return parts


def format_message(message: MessageParam, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Format one message for the OpenAI chat-completions body.

    Reasoning never travels in the content array: it lands in a top-level field on
    the assistant message instead, since content parts are the wrong shape for it.
    """
    thinking = next((b for b in message.content if isinstance(b, ThinkingContent)), None)
    rest = [b for b in message.content if not isinstance(b, ThinkingContent)]
    content_items = rest if rest else [TextContent(value="")]

    formatted: dict[str, Any] = {
        "role": message.role,
        "content": _format_content(content_items, base_dir),
    }

    if thinking is not None and message.role == "assistant":
        payload = thinking.payload
        has_details = payload is not None and payload.kind == "reasoning_details"
        if has_details and payload is not None and payload.reasoning_details:
            formatted["reasoning_details"] = payload.reasoning_details
        elif thinking.value.strip() != "":
            field = (payload.reasoning_field if payload else None) or "reasoning_content"
            formatted[field] = thinking.value

    return formatted


async def _translate_stream(
    chunks: AsyncIterable[Any], model_name: str
) -> AsyncIterator[StreamEvent]:
    """Turn raw stream chunks into :class:`StreamEvent` values.

    The SDK owns SSE framing and JSON parsing now, so the TS corrupted-JSON salvage
    path (regexing ``"content":"..."`` out of unparseable SSE data) has no
    equivalent here and is intentionally not ported. Likewise the TS belt-and-braces
    scan of the last few raw chunks for ``finish_reason":"length"`` before `[DONE]`
    is unnecessary: the SDK exposes ``finish_reason`` directly on every chunk.
    """
    accumulator = ReasoningDetailsAccumulator()
    reasoning_field: ReasoningFieldName = "reasoning_content"
    reasoning_open = False
    running_usage: Usage | None = None

    def close_reasoning() -> ThinkingPayloadDelta:
        nonlocal accumulator, reasoning_open
        reasoning_open = False
        if accumulator.has_details():
            payload = ThinkingPayload(
                kind="reasoning_details", reasoning_details=accumulator.get_details()
            )
        else:
            payload = ThinkingPayload(kind="raw", reasoning_field=reasoning_field)
        accumulator = ReasoningDetailsAccumulator()
        return ThinkingPayloadDelta(model=model_name, payload=payload)

    async for chunk in chunks:
        usage = getattr(chunk, "usage", None)
        if usage is not None:
            details = getattr(usage, "prompt_tokens_details", None)
            delta_usage = Usage(
                input_tokens=getattr(usage, "prompt_tokens", None),
                output_tokens=getattr(usage, "completion_tokens", None),
                cache_read_tokens=getattr(details, "cached_tokens", None),
            )
            running_usage = (running_usage or Usage()).merge(delta_usage)
            yield UsageDelta(usage=running_usage)

        choices = getattr(chunk, "choices", None)
        if not choices:
            continue
        choice = choices[0]
        delta = getattr(choice, "delta", None)

        found_text_field = False
        if delta is not None:
            # Reasoning deltas arrive before content on reasoning models. Only the
            # first populated field is used; providers sometimes echo the same
            # reasoning into several fields at once.
            for field in REASONING_TEXT_FIELDS:
                value = getattr(delta, field, None)
                if isinstance(value, str) and value:
                    reasoning_field = field
                    reasoning_open = True
                    yield ThinkingDelta(text=value)
                    found_text_field = True
                    break

            # reasoning_details is always accumulated, because it is the only form
            # that can be replayed verbatim next turn. Its text is only emitted when
            # no text field already carried it (OpenRouter sends both
            # reasoning_content and reasoning_details with identical text, which
            # would otherwise duplicate every reasoning chunk).
            detail_list = getattr(delta, "reasoning_details", None)
            if isinstance(detail_list, list):
                for detail in detail_list:
                    text = accumulator.process_delta(detail)
                    reasoning_open = True
                    if text and not found_text_field:
                        yield ThinkingDelta(text=text)

        content = getattr(delta, "content", None) if delta is not None else None

        # The first content delta closes the reasoning run.
        if content and reasoning_open:
            yield close_reasoning()

        finish_reason = getattr(choice, "finish_reason", None)
        if finish_reason == "length":
            if content:
                yield TextDelta(text=content)
            raise MaxTokensError("OpenAI chat completion stopped early: finish_reason=length")

        if content:
            yield TextDelta(text=content)

    if reasoning_open:
        yield close_reasoning()


class OpenAIChatClient:
    """Streams assistant turns from an OpenAI-compatible ``/chat/completions`` API."""

    def __init__(self, config: ResolvedConfig) -> None:
        self.config = config
        self.last_usage: Usage | None = None
        self._client = AsyncOpenAI(api_key=config.api_key, base_url=config.base_url)

    async def stream(
        self,
        messages: list[MessageParam],
        system_prompt: str,
        *,
        base_dir: str | Path | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Yield events for one assistant turn."""
        self.last_usage = None
        model_name = self.config.model_name or DEFAULT_MODEL

        cleaned = clean_messages_for_api(
            messages,
            model_name=model_name,
            thinking_enabled=self.config.thinking_enabled,
            api_style="openai_chat",
        )
        formatted_messages = [format_message(message, base_dir) for message in cleaned]
        request = build_request_kwargs(
            model=model_name,
            system_prompt=system_prompt,
            formatted_messages=formatted_messages,
            max_tokens=self.config.max_tokens,
            reasoning_effort=self.config.reasoning_effort,
        )

        logger.debug("Starting OpenAI chat completion request for model %s", model_name)
        try:
            response = await self._client.chat.completions.create(**request)
            async for event in _translate_stream(response, model_name):
                if isinstance(event, UsageDelta):
                    self.last_usage = event.usage
                yield event
        except openai.RateLimitError as exc:
            raise RetryableError(str(exc)) from exc
        except openai.APIStatusError as exc:
            if exc.status_code >= 500:
                raise RetryableError(str(exc)) from exc
            raise
        except openai.APIConnectionError as exc:
            raise RetryableError(str(exc)) from exc
