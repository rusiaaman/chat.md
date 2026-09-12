"""Client for the OpenAI Responses API.

A port of ``src/openaiResponsesClient.ts``, backed by the official ``openai`` SDK
instead of hand-rolled HTTPS/SSE.

Requests are stateless (``store=False``) because chat.md keeps the whole
conversation in the document, and encrypted reasoning is requested so the
reasoning items can be replayed on later turns -- the only way to keep reasoning
context across turns on OpenAI-hosted gpt-* and o-series models.
"""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import AsyncIterable, AsyncIterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from openai import APIConnectionError, APIStatusError, AsyncOpenAI

from ..config.model import ResolvedConfig
from ..fileio import get_mime_type, read_bytes, resolve_file_path
from ..types import (
    Content,
    ImageContent,
    MessageParam,
    ReasoningEffort,
    StreamEvent,
    TextContent,
    TextDelta,
    ThinkingContent,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    ToolResultContent,
    ToolUseContent,
    Usage,
    UsageDelta,
)
from .base import MaxTokensError, RetryableError
from .cleanup import clean_messages_for_api
from .native_tools import (
    NativeToolDefinition,
    api_tool_name,
    canonical_tool_name,
    openai_responses_tool_schemas,
    render_tool_arguments_delta,
    render_tool_call_end,
    render_tool_call_start,
    uses_native_tools,
)

logger = logging.getLogger(__name__)

#: Matches the TS client's fallback when no model is configured.
DEFAULT_MODEL = "gpt-4.1-mini"


def build_request_kwargs(
    *,
    model: str,
    input_items: list[dict[str, Any]],
    instructions: str,
    max_output_tokens: int,
    thinking_enabled: bool,
    reasoning_effort: ReasoningEffort | None,
) -> dict[str, Any]:
    """Build the ``responses.create`` keyword arguments (pure, no I/O)."""
    kwargs: dict[str, Any] = {
        "model": model,
        "input": input_items,
        "instructions": instructions,
        "max_output_tokens": max_output_tokens,
        "stream": True,
        # Stateless: chat.md keeps the whole conversation in the document.
        "store": False,
    }
    if thinking_enabled:
        reasoning: dict[str, Any] = {"summary": "auto"}
        if reasoning_effort:
            reasoning["effort"] = reasoning_effort
        kwargs["reasoning"] = reasoning
        # Without this the encrypted reasoning cannot be replayed later.
        kwargs["include"] = ["reasoning.encrypted_content"]
    return kwargs


def convert_to_responses_input(
    messages: Sequence[MessageParam], *, base_dir: str | Path | None = None
) -> list[dict[str, Any]]:
    """Convert cleaned chat.md messages into Responses API input items.

    A reasoning item must precede the assistant message it belongs to; this falls
    out naturally because cleanup moves thinking to the front of assistant content.
    """
    input_items: list[dict[str, Any]] = []

    for message in messages:
        if message.role == "assistant":
            text_parts: list[dict[str, Any]] = []

            for block in message.content:
                if isinstance(block, ThinkingContent):
                    payload = block.payload
                    if (
                        payload is not None
                        and payload.kind == "openai_encrypted"
                        and payload.item_id
                        and payload.encrypted_content
                    ):
                        input_items.append(
                            {
                                "id": payload.item_id,
                                "type": "reasoning",
                                "summary": [],
                                "encrypted_content": payload.encrypted_content,
                            }
                        )
                    # Raw reasoning text has nothing replayable in this API.
                    continue

                if isinstance(block, TextContent):
                    if block.value.strip() != "":
                        text_parts.append(
                            {"type": "output_text", "text": block.value, "annotations": []}
                        )
                elif isinstance(block, ImageContent):
                    text_parts.append(
                        {"type": "output_text", "text": "[Assistant Image]", "annotations": []}
                    )

            if text_parts:
                input_items.append({"role": "assistant", "content": text_parts})
            continue

        user_parts: list[dict[str, Any]] = []
        for block in message.content:
            if isinstance(block, TextContent):
                if block.value.strip() != "":
                    user_parts.append({"type": "input_text", "text": block.value})
            elif isinstance(block, ImageContent):
                image_url = _build_image_data_url(block.path, base_dir)
                if image_url:
                    user_parts.append({"type": "input_image", "image_url": image_url})
                else:
                    user_parts.append(
                        {"type": "input_text", "text": f"[Failed to load image: {block.path}]"}
                    )

        if user_parts:
            input_items.append({"role": "user", "content": user_parts})

    return input_items


def convert_to_responses_input_with_tools(
    messages: Sequence[MessageParam],
    tools: Sequence[NativeToolDefinition],
    native: bool,
    base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    if not native:
        materialized: list[MessageParam] = []
        for message in messages:
            content: list[Content] = []
            has_tool_use = False
            for block in message.content:
                if isinstance(block, ToolUseContent):
                    content.append(TextContent(value=block.raw_xml))
                    has_tool_use = True
                elif isinstance(block, ToolResultContent):
                    content.append(TextContent(value=block.raw_text))
                else:
                    content.append(block)
            if has_tool_use:
                content.append(TextContent(value="<cmd:wait-tool-result/>"))
            materialized.append(MessageParam(role=message.role, content=content))
        return convert_to_responses_input(materialized, base_dir=base_dir)

    input_items: list[dict[str, Any]] = []
    for message in messages:
        normal: list[Content] = [
            block
            for block in message.content
            if not isinstance(block, (ToolUseContent, ToolResultContent))
        ]
        input_items.extend(
            convert_to_responses_input(
                [MessageParam(role=message.role, content=normal)], base_dir=base_dir
            )
        )
        for block in message.content:
            if isinstance(block, ToolUseContent):
                input_items.append(
                    {
                        "type": "function_call",
                        "name": api_tool_name(block.name, tools),
                        "arguments": json.dumps(block.input, separators=(",", ":")),
                        "call_id": block.id,
                    }
                )
            elif isinstance(block, ToolResultContent):
                output: list[dict[str, Any]] = []
                for part in block.content:
                    if isinstance(part, TextContent):
                        output.append({"type": "input_text", "text": part.value})
                    else:
                        image_url = _build_image_data_url(part.path, base_dir)
                        if image_url:
                            output.append({"type": "input_image", "image_url": image_url})
                        else:
                            output.append(
                                {
                                    "type": "input_text",
                                    "text": f"[Failed to load image: {part.path}]",
                                }
                            )
                input_items.append(
                    {
                        "type": "function_call_output",
                        "call_id": block.tool_use_id,
                        "output": output,
                    }
                )
    return input_items


@dataclass
class _PartialFunctionCall:
    output_index: int
    call_id: str = ""
    name: str = ""
    arguments: str = ""
    emitted: int = 0
    started: bool = False
    done: bool = False
    closed: bool = False


def _build_image_data_url(path: str, base_dir: str | Path | None) -> str | None:
    """Read a user-attached image off disk and encode it as a data URL."""
    try:
        resolved = resolve_file_path(path, base_dir)
    except OSError as exc:
        logger.warning("Error processing image %s: %s", path, exc)
        return None
    data = read_bytes(resolved)
    if data is None:
        return None
    mime = get_mime_type(resolved)
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _normalize_base_url(base_url: str | None) -> str | None:
    """Undo a trailing "/responses" a custom base URL might already carry.

    The TS client built the request URL itself and accepted a base URL with or
    without that suffix; the openai SDK appends it for us, so keeping it would
    double it up.
    """
    if not base_url or not base_url.strip():
        return None
    trimmed = base_url.rstrip("/")
    if trimmed.lower().endswith("/responses"):
        trimmed = trimmed[: -len("/responses")]
    return trimmed or None


def _extract_usage(event: Any) -> Usage | None:
    """Pull a usage snapshot off any event that carries one.

    Usage rides on ``response.completed``/``incomplete``/``failed`` events, all of
    which expose it as ``event.response.usage``; duck-typed so it also matches the
    event-shaped stubs used in tests.
    """
    response_obj = getattr(event, "response", None)
    usage = getattr(response_obj, "usage", None) if response_obj is not None else None
    if usage is None:
        usage = getattr(event, "usage", None)
    if usage is None:
        return None
    details = getattr(usage, "input_tokens_details", None)
    cache_read = getattr(details, "cached_tokens", None) if details is not None else None
    return Usage(
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        cache_read_tokens=cache_read,
    )


class OpenAIResponsesClient:
    """Streaming client for the OpenAI Responses API."""

    manages_tools = False

    def __init__(self, config: ResolvedConfig) -> None:
        self.config = config
        self.last_usage: Usage | None = None
        self._client = AsyncOpenAI(
            api_key=config.api_key, base_url=_normalize_base_url(config.base_url)
        )

    def cancel(self) -> None:
        return

    async def stream(
        self,
        messages: list[MessageParam],
        system_prompt: str,
        tools: Sequence[NativeToolDefinition],
        *,
        base_dir: str | Path | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Yield events for one assistant turn."""
        self.last_usage = None
        model = self.config.model_name or DEFAULT_MODEL
        native = uses_native_tools(model)
        thinking_enabled = self.config.thinking_enabled

        logger.info("Starting OpenAI Responses request with %d messages", len(messages))

        cleaned = clean_messages_for_api(
            messages,
            model_name=model,
            thinking_enabled=thinking_enabled,
            api_style="openai_responses",
        )
        input_items = convert_to_responses_input_with_tools(
            cleaned, tools, native, base_dir
        )
        kwargs = build_request_kwargs(
            model=model,
            input_items=input_items,
            instructions=system_prompt,
            max_output_tokens=self.config.max_tokens,
            thinking_enabled=thinking_enabled,
            reasoning_effort=self.config.reasoning_effort,
        )
        if native and tools:
            kwargs["tools"] = openai_responses_tool_schemas(tools)

        try:
            response_stream = await self._client.responses.create(**kwargs)
            async for event in self._translate_stream(response_stream, model, tools):
                yield event
        except APIConnectionError as exc:
            # Covers APITimeoutError too, which subclasses APIConnectionError.
            raise RetryableError(str(exc)) from exc
        except APIStatusError as exc:
            # RateLimitError (429) subclasses APIStatusError, so this covers it too.
            if exc.status_code >= 500 or exc.status_code == 429:
                raise RetryableError(str(exc)) from exc
            raise

    async def _translate_stream(
        self,
        events: AsyncIterable[Any],
        model: str,
        tools: Sequence[NativeToolDefinition],
    ) -> AsyncIterator[StreamEvent]:
        """Translate Responses SSE events into StreamEvents, tracking usage as it goes.

        Dispatches on ``event.type`` rather than the SDK's typed event classes -- the
        same duck-typed shape the TS client's ``switch (data.type)`` and the sibling
        chat-completions/Anthropic clients use, so this reads production SSE events and
        lightweight test stand-ins alike.

        Text arrives as ``response.output_text.delta``, reasoning summaries as
        ``response.reasoning_summary_text.delta``, and the encrypted payload only
        shows up once the reasoning item is done.
        """
        calls: dict[int, _PartialFunctionCall] = {}
        active_index: int | None = None
        async for event in events:
            usage_delta = _extract_usage(event)
            if usage_delta is not None:
                merged = (
                    usage_delta
                    if self.last_usage is None
                    else self.last_usage.merge(usage_delta)
                )
                self.last_usage = merged
                yield UsageDelta(usage=merged)

            event_type = getattr(event, "type", None)

            if event_type == "response.output_item.added":
                item = getattr(event, "item", None)
                if getattr(item, "type", None) == "function_call":
                    index = getattr(event, "output_index", 0)
                    state = calls.setdefault(
                        index, _PartialFunctionCall(output_index=index)
                    )
                    state.call_id = getattr(item, "call_id", "") or state.call_id
                    state.name = getattr(item, "name", "") or state.name
                    initial = getattr(item, "arguments", "") or ""
                    state.arguments += initial
                    if active_index is None:
                        active_index = index
                        state.started = True
                        yield TextDelta(
                            render_tool_call_start(
                                state.call_id or f"chatmd_call_{index}",
                                canonical_tool_name(state.name, tools),
                            )
                        )
                        if state.arguments:
                            state.emitted = len(state.arguments)
                            yield TextDelta(render_tool_arguments_delta(state.arguments))
                continue

            if event_type == "response.function_call_arguments.delta":
                index = getattr(event, "output_index", 0)
                state = calls.setdefault(index, _PartialFunctionCall(output_index=index))
                delta = getattr(event, "delta", "") or ""
                state.arguments += delta
                if active_index == index and delta:
                    state.emitted = len(state.arguments)
                    yield TextDelta(render_tool_arguments_delta(delta))
                continue

            if event_type == "response.function_call_arguments.done":
                index = getattr(event, "output_index", 0)
                state = calls.setdefault(index, _PartialFunctionCall(output_index=index))
                final_arguments = getattr(event, "arguments", None)
                if isinstance(final_arguments, str) and final_arguments:
                    state.arguments = final_arguments
                state.done = True
                if active_index == index:
                    pending = state.arguments[state.emitted :]
                    if pending:
                        yield TextDelta(render_tool_arguments_delta(pending))
                    yield TextDelta(render_tool_call_end())
                    state.closed = True
                    active_index = None
                    while active_index is None:
                        pending_candidate = next(
                            (
                                (candidate_index, candidate)
                                for candidate_index, candidate in calls.items()
                                if not candidate.started and not candidate.closed
                            ),
                            None,
                        )
                        if pending_candidate is None:
                            break
                        candidate_index, candidate = pending_candidate
                        candidate.started = True
                        active_index = candidate_index
                        yield TextDelta(
                            render_tool_call_start(
                                candidate.call_id or f"chatmd_call_{candidate_index}",
                                canonical_tool_name(candidate.name, tools),
                            )
                        )
                        if candidate.arguments:
                            candidate.emitted = len(candidate.arguments)
                            yield TextDelta(
                                render_tool_arguments_delta(candidate.arguments)
                            )
                        if candidate.done:
                            yield TextDelta(render_tool_call_end())
                            candidate.closed = True
                            active_index = None
                        else:
                            break
                continue

            if event_type == "response.output_text.delta":
                delta = getattr(event, "delta", None)
                if delta:
                    yield TextDelta(text=delta)
            elif event_type in (
                "response.reasoning_summary_text.delta",
                "response.reasoning_text.delta",
            ):
                delta = getattr(event, "delta", None)
                if delta:
                    yield ThinkingDelta(text=delta)
            elif event_type == "response.output_item.done":
                item = getattr(event, "item", None)
                encrypted_content = getattr(item, "encrypted_content", None)
                if getattr(item, "type", None) == "reasoning" and encrypted_content:
                    item_id = getattr(item, "id", None)
                    logger.info("Received encrypted reasoning item %s", item_id)
                    yield ThinkingPayloadDelta(
                        model=model,
                        payload=ThinkingPayload(
                            kind="openai_encrypted",
                            item_id=item_id,
                            encrypted_content=encrypted_content,
                        ),
                    )
                elif getattr(item, "type", None) == "function_call":
                    index = getattr(event, "output_index", 0)
                    state = calls.setdefault(
                        index, _PartialFunctionCall(output_index=index)
                    )
                    state.call_id = getattr(item, "call_id", "") or state.call_id
                    state.name = getattr(item, "name", "") or state.name
                    final_arguments = getattr(item, "arguments", None)
                    if isinstance(final_arguments, str) and final_arguments:
                        state.arguments = final_arguments
            elif event_type == "response.incomplete":
                response_obj = getattr(event, "response", None)
                incomplete_details = getattr(response_obj, "incomplete_details", None)
                reason = getattr(incomplete_details, "reason", None)
                logger.info("Responses API incomplete: %s", reason)
                if reason == "max_output_tokens":
                    raise MaxTokensError("Response incomplete due to token limit")
            elif event_type in ("response.failed", "error"):
                response_obj = getattr(event, "response", None)
                error_obj = getattr(response_obj, "error", None)
                message = (
                    getattr(error_obj, "message", None)
                    or getattr(event, "message", None)
                    or "unknown error"
                )
                logger.error("Responses API error event: %s", message)
                raise RuntimeError(f"Responses API error: {message}")

        for index, state in calls.items():
            if state.closed:
                continue
            if not state.started:
                yield TextDelta(
                    render_tool_call_start(
                        state.call_id or f"chatmd_call_{index}",
                        canonical_tool_name(state.name, tools),
                    )
                )
            pending = state.arguments[state.emitted :]
            if pending:
                yield TextDelta(render_tool_arguments_delta(pending))
            yield TextDelta(render_tool_call_end())
