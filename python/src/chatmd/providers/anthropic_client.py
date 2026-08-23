"""Anthropic streaming client, built on the official ``anthropic`` Python SDK.

A port of ``src/anthropicClient.ts``. The SDK's typed ``thinking``/``output_config``
parameters (``anthropic`` 1.x) replace the hand-rolled HTTPS/SSE parsing and the
``extra_body`` workarounds the TS file needed, but the request-shaping decisions
(when thinking is adaptive vs. budgeted, when the interleaved-thinking beta header
is required, how a max_tokens/budget conflict is resolved) are carried over as-is.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import AsyncIterable, AsyncIterator, Sequence
from pathlib import Path
from typing import Any

import anthropic

from ..config.model import DEFAULT_MAX_THINKING_TOKENS, ResolvedConfig
from ..fileio import get_mime_type, read_bytes, resolve_file_path
from ..types import (
    Content,
    ImageContent,
    MessageParam,
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
from .capabilities import (
    calculate_thinking_tokens_from_effort,
    is_adaptive_thinking_model,
    needs_interleaved_thinking_beta,
    omits_thinking_by_default,
    requires_always_on_thinking,
    to_adaptive_effort,
)
from .cleanup import clean_messages_for_api

logger = logging.getLogger(__name__)

#: Matches the TS fallback exactly; used when no model is configured anywhere.
DEFAULT_MODEL = "claude-3-5-haiku-latest"
_INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
_CONTINUING_PLACEHOLDER = "[continuing]"
_MIN_THINKING_BUDGET_TOKENS = 1024


class AnthropicClient:
    """Streams assistant turns from the Anthropic Messages API."""

    def __init__(self, config: ResolvedConfig) -> None:
        self.config = config
        self.last_usage: Usage | None = None
        client_kwargs: dict[str, Any] = {"api_key": config.api_key}
        if config.base_url:
            client_kwargs["base_url"] = config.base_url
        self._client = anthropic.AsyncAnthropic(**client_kwargs)

    async def stream(
        self,
        messages: list[MessageParam],
        system_prompt: str,
        *,
        base_dir: str | Path | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Yield events for one assistant turn, raising on transport failure."""
        self.last_usage = None
        model_name = self.config.model_name or DEFAULT_MODEL
        kwargs = self._build_request(messages, system_prompt, base_dir=base_dir)

        logger.info("Starting Anthropic request with %d messages", len(messages))
        try:
            raw_stream = await self._client.messages.create(**kwargs)
            async for event in self._iter_stream_events(raw_stream, model_name):
                yield event
        except MaxTokensError:
            raise
        except anthropic.RateLimitError as exc:
            # 429s are retried by the engine with backoff.
            raise RetryableError(str(exc)) from exc
        except anthropic.APIConnectionError as exc:
            # Connection drops and timeouts are transient.
            raise RetryableError(str(exc)) from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code >= 500 or exc.status_code == 429:
                raise RetryableError(str(exc)) from exc
            raise

    # -- request shaping ---------------------------------------------------- #

    def _build_request(
        self,
        messages: Sequence[MessageParam],
        system_prompt: str,
        *,
        base_dir: str | Path | None = None,
    ) -> dict[str, Any]:
        """Build the ``messages.create`` kwargs, mirroring the TS request body."""
        config = self.config
        model_name = config.model_name or DEFAULT_MODEL
        max_tokens = config.max_tokens
        # Thinking is on unless it was explicitly turned off.
        thinking_enabled = config.reasoning_effort != "none"
        adaptive = is_adaptive_thinking_model(model_name)

        thinking_config: dict[str, Any] | None = None
        output_config: dict[str, Any] | None = None

        if adaptive:
            # Claude 4.6+ replaced budget_tokens with adaptive thinking + effort.
            if thinking_enabled:
                thinking_config = {"type": "adaptive"}
                if omits_thinking_by_default(model_name):
                    # These models omit thinking content unless asked for a summary.
                    thinking_config["display"] = "summarized"
                if config.reasoning_effort:
                    output_config = {"effort": to_adaptive_effort(config.reasoning_effort)}
            elif not requires_always_on_thinking(model_name):
                thinking_config = {"type": "disabled"}
            # else: the model rejects a disabled config, so the param is omitted.
        elif thinking_enabled:
            # Older models: extended thinking with an explicit token budget.
            thinking_tokens: int | None = None
            if (
                config.max_thinking_tokens
                and config.max_thinking_tokens != DEFAULT_MAX_THINKING_TOKENS
            ):
                thinking_tokens = config.max_thinking_tokens
            elif config.reasoning_effort:
                thinking_tokens = calculate_thinking_tokens_from_effort(
                    max_tokens, config.reasoning_effort
                )
            # else: no thinking token configuration; let Anthropic decide.

            if thinking_tokens:
                budget_tokens = max(_MIN_THINKING_BUDGET_TOKENS, thinking_tokens)
                thinking_config = {"type": "enabled", "budget_tokens": budget_tokens}
                # Anthropic requires max_tokens to be greater than the thinking budget.
                if max_tokens <= budget_tokens:
                    max_tokens = budget_tokens + config.max_tokens

        # Thinking blocks may only be replayed when thinking is actually enabled.
        thinking_active = thinking_config is not None and thinking_enabled

        cleaned_messages = clean_messages_for_api(
            list(messages),
            model_name=model_name,
            thinking_enabled=thinking_active,
            api_style="anthropic",
        )

        kwargs: dict[str, Any] = {
            "model": model_name,
            "system": system_prompt,
            "stream": True,
            "max_tokens": max_tokens,
            "messages": self._format_messages(cleaned_messages, base_dir=base_dir),
        }
        if thinking_config is not None:
            kwargs["thinking"] = thinking_config
        if output_config is not None:
            kwargs["output_config"] = output_config
        if thinking_active and needs_interleaved_thinking_beta(model_name):
            kwargs["extra_headers"] = {"anthropic-beta": _INTERLEAVED_THINKING_BETA}

        return kwargs

    # -- content formatting -------------------------------------------------- #

    def _format_messages(
        self, messages: Sequence[MessageParam], *, base_dir: str | Path | None
    ) -> list[dict[str, Any]]:
        return [
            {
                "role": message.role,
                "content": self._format_content(message.content, base_dir=base_dir),
            }
            for message in messages
        ]

    def _format_content(
        self, content_items: Sequence[Content], *, base_dir: str | Path | None
    ) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        for content in content_items:
            if isinstance(content, TextContent):
                blocks.append({"type": "text", "text": content.value})
            elif isinstance(content, ThinkingContent):
                payload = content.payload
                if payload is not None and payload.kind == "anthropic_redacted" and payload.data:
                    blocks.append({"type": "redacted_thinking", "data": payload.data})
                elif (
                    payload is not None
                    and payload.kind == "anthropic_signature"
                    and payload.signature
                ):
                    # Opaque content exists, so the text is irrelevant to the API.
                    blocks.append(
                        {"type": "thinking", "thinking": "", "signature": payload.signature}
                    )
                else:
                    # Raw thinking without a signature cannot be replayed to Anthropic.
                    logger.debug("Skipping thinking block without an Anthropic signature")
            elif isinstance(content, ImageContent):
                blocks.append(self._format_image(content, base_dir=base_dir))

        if not blocks:
            blocks.append({"type": "text", "text": _CONTINUING_PLACEHOLDER})
        return blocks

    def _format_image(
        self, content: ImageContent, *, base_dir: str | Path | None
    ) -> dict[str, Any]:
        image_path = resolve_file_path(content.path, base_dir)
        data = read_bytes(image_path)
        if data is None:
            logger.warning("Failed to load image: %s", content.path)
            return {"type": "text", "text": f"[Failed to load image: {content.path}]"}
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": get_mime_type(image_path),
                "data": base64.standard_b64encode(data).decode("ascii"),
            },
        }

    # -- stream translation --------------------------------------------------- #

    async def _iter_stream_events(
        self, raw_events: AsyncIterable[Any], model_name: str
    ) -> AsyncIterator[StreamEvent]:
        """Map raw Anthropic SSE events onto StreamEvents.

        Duck-typed on ``.type``/attribute access rather than the SDK's event
        classes, so this is unit-testable with plain stub objects.
        """
        async for event in raw_events:
            event_type = getattr(event, "type", None)

            if event_type == "content_block_delta":
                delta = event.delta
                delta_type = getattr(delta, "type", None)
                if delta_type == "text_delta":
                    text = getattr(delta, "text", "")
                    if text:
                        yield TextDelta(text)
                elif delta_type == "thinking_delta":
                    thinking = getattr(delta, "thinking", "")
                    if thinking:
                        yield ThinkingDelta(thinking)
                elif delta_type == "signature_delta":
                    # The signature closes the thinking block.
                    signature = getattr(delta, "signature", None)
                    if signature:
                        yield ThinkingPayloadDelta(
                            model=model_name,
                            payload=ThinkingPayload(
                                kind="anthropic_signature", signature=signature
                            ),
                        )

            elif event_type == "content_block_start":
                block = event.content_block
                block_type = getattr(block, "type", None)
                if block_type == "redacted_thinking":
                    data = getattr(block, "data", None)
                    if data:
                        yield ThinkingDelta("[redacted thinking]")
                        yield ThinkingPayloadDelta(
                            model=model_name,
                            payload=ThinkingPayload(kind="anthropic_redacted", data=data),
                        )
                elif block_type == "thinking":
                    thinking_text = getattr(block, "thinking", "")
                    if thinking_text:
                        yield ThinkingDelta(thinking_text)

            elif event_type == "message_start":
                usage = getattr(event.message, "usage", None)
                if usage is not None:
                    yield UsageDelta(self._merge_usage(usage))

            elif event_type == "message_delta":
                usage = getattr(event, "usage", None)
                if usage is not None:
                    yield UsageDelta(self._merge_usage(usage))
                stop_reason = getattr(getattr(event, "delta", None), "stop_reason", None)
                if stop_reason == "max_tokens":
                    raise MaxTokensError(
                        f"Anthropic response for {model_name} stopped at max_tokens"
                    )

    def _merge_usage(self, sdk_usage: Any) -> Usage:
        """Fold one SSE usage snapshot into ``self.last_usage`` without wiping fields."""
        delta = Usage(
            input_tokens=getattr(sdk_usage, "input_tokens", None),
            output_tokens=getattr(sdk_usage, "output_tokens", None),
            cache_read_tokens=getattr(sdk_usage, "cache_read_input_tokens", None),
            cache_write_tokens=getattr(sdk_usage, "cache_creation_input_tokens", None),
        )
        base = self.last_usage or Usage()
        self.last_usage = base.merge(delta)
        return self.last_usage
