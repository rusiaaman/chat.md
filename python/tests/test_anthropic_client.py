"""Unit tests for chatmd.providers.anthropic_client — no network access.

Covers three things: (1) the pure ``_build_request`` thinking/beta-header shaping
table, (2) translation of raw Anthropic SSE-shaped events into StreamEvents, and
(3) the content formatter's edge cases (unreadable image, unreplayable raw
thinking, an emptied message).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from chatmd.config.model import DEFAULT_MAX_THINKING_TOKENS, ResolvedConfig
from chatmd.providers.anthropic_client import DEFAULT_MODEL, AnthropicClient
from chatmd.providers.base import MaxTokensError
from chatmd.types import (
    ImageContent,
    MessageParam,
    ReasoningEffort,
    TextContent,
    TextDelta,
    ThinkingContent,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    Usage,
    UsageDelta,
)

SIMPLE_MESSAGES = [MessageParam(role="user", content=[TextContent(value="hi")])]


def make_config(
    *,
    model_name: str | None,
    reasoning_effort: ReasoningEffort | None,
    max_tokens: int = 8000,
    max_thinking_tokens: int = DEFAULT_MAX_THINKING_TOKENS,
    base_url: str | None = None,
) -> ResolvedConfig:
    return ResolvedConfig(
        provider="anthropic",
        api_key="test-key",
        model_name=model_name,
        base_url=base_url,
        max_tokens=max_tokens,
        max_thinking_tokens=max_thinking_tokens,
        reasoning_effort=reasoning_effort,
    )


def make_client(**config_kwargs: Any) -> AnthropicClient:
    config_kwargs.setdefault("model_name", "claude-opus-4-6")
    config_kwargs.setdefault("reasoning_effort", "high")
    return AnthropicClient(make_config(**config_kwargs))


# --------------------------------------------------------------------------- #
# Request shaping
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ThinkingCase:
    label: str
    model_name: str
    reasoning_effort: ReasoningEffort | None
    max_tokens: int
    max_thinking_tokens: int
    expected_thinking: dict[str, Any] | None
    expected_output_config: dict[str, Any] | None
    expected_max_tokens: int
    expected_beta: bool


THINKING_CASES = [
    ThinkingCase(
        label="adaptive_effort_high",
        model_name="claude-opus-4-6",
        reasoning_effort="high",
        max_tokens=8000,
        max_thinking_tokens=DEFAULT_MAX_THINKING_TOKENS,
        expected_thinking={"type": "adaptive"},
        expected_output_config={"effort": "high"},
        expected_max_tokens=8000,
        expected_beta=False,
    ),
    ThinkingCase(
        label="adaptive_4_7_plus_summarized_display",
        model_name="claude-opus-4-7",
        reasoning_effort="high",
        max_tokens=8000,
        max_thinking_tokens=DEFAULT_MAX_THINKING_TOKENS,
        expected_thinking={"type": "adaptive", "display": "summarized"},
        expected_output_config={"effort": "high"},
        expected_max_tokens=8000,
        expected_beta=False,
    ),
    ThinkingCase(
        label="fable_thinking_off_param_omitted_entirely",
        model_name="claude-fable-5",
        reasoning_effort="none",
        max_tokens=8000,
        max_thinking_tokens=DEFAULT_MAX_THINKING_TOKENS,
        expected_thinking=None,
        expected_output_config=None,
        expected_max_tokens=8000,
        expected_beta=False,
    ),
    ThinkingCase(
        label="older_explicit_budget_raises_max_tokens",
        model_name="claude-3-5-sonnet-20241022",
        reasoning_effort="high",
        max_tokens=8000,
        max_thinking_tokens=20000,
        expected_thinking={"type": "enabled", "budget_tokens": 20000},
        expected_output_config=None,
        expected_max_tokens=28000,
        expected_beta=False,
    ),
    ThinkingCase(
        label="older_effort_only",
        model_name="claude-opus-4-5",
        reasoning_effort="medium",
        max_tokens=8000,
        max_thinking_tokens=DEFAULT_MAX_THINKING_TOKENS,
        expected_thinking={"type": "enabled", "budget_tokens": 4000},
        expected_output_config=None,
        expected_max_tokens=8000,
        expected_beta=True,
    ),
    ThinkingCase(
        label="thinking_off_on_non_adaptive_model",
        model_name="claude-opus-4-5",
        reasoning_effort="none",
        max_tokens=8000,
        max_thinking_tokens=DEFAULT_MAX_THINKING_TOKENS,
        expected_thinking=None,
        expected_output_config=None,
        expected_max_tokens=8000,
        expected_beta=False,
    ),
]


@pytest.mark.parametrize("case", THINKING_CASES, ids=lambda c: c.label)
def test_build_request_thinking_shape(case: ThinkingCase) -> None:
    client = AnthropicClient(
        make_config(
            model_name=case.model_name,
            reasoning_effort=case.reasoning_effort,
            max_tokens=case.max_tokens,
            max_thinking_tokens=case.max_thinking_tokens,
        )
    )

    kwargs = client._build_request(SIMPLE_MESSAGES, "system prompt")

    assert kwargs.get("thinking") == case.expected_thinking
    assert kwargs.get("output_config") == case.expected_output_config
    assert kwargs["max_tokens"] == case.expected_max_tokens
    assert kwargs["model"] == case.model_name
    assert kwargs["system"] == "system prompt"
    assert kwargs["stream"] is True
    assert kwargs["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "hi"}]}
    ]

    beta_header = kwargs.get("extra_headers", {}).get("anthropic-beta")
    assert (beta_header == "interleaved-thinking-2025-05-14") == case.expected_beta


def test_build_request_falls_back_to_default_model() -> None:
    client = AnthropicClient(make_config(model_name=None, reasoning_effort="none"))
    kwargs = client._build_request(SIMPLE_MESSAGES, "sys")
    assert kwargs["model"] == DEFAULT_MODEL


def test_client_uses_configured_base_url() -> None:
    client = AnthropicClient(
        make_config(
            model_name="claude-opus-4-6",
            reasoning_effort="none",
            base_url="https://example.test",
        )
    )
    assert str(client._client.base_url) == "https://example.test"


def test_client_defaults_base_url_when_unset() -> None:
    client = AnthropicClient(make_config(model_name="claude-opus-4-6", reasoning_effort="none"))
    assert str(client._client.base_url) == "https://api.anthropic.com"


# --------------------------------------------------------------------------- #
# Stream event translation
# --------------------------------------------------------------------------- #


def _text_delta_event(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta", delta=SimpleNamespace(type="text_delta", text=text)
    )


def _thinking_delta_event(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta", delta=SimpleNamespace(type="thinking_delta", thinking=text)
    )


def _signature_delta_event(signature: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="signature_delta", signature=signature),
    )


def _thinking_block_start_event(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_start",
        content_block=SimpleNamespace(type="thinking", thinking=text),
    )


def _redacted_thinking_block_start_event(data: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_start",
        content_block=SimpleNamespace(type="redacted_thinking", data=data),
    )


def _message_start_event(**usage_fields: Any) -> SimpleNamespace:
    return SimpleNamespace(
        type="message_start", message=SimpleNamespace(usage=SimpleNamespace(**usage_fields))
    )


def _message_delta_event(stop_reason: str | None, **usage_fields: Any) -> SimpleNamespace:
    return SimpleNamespace(
        type="message_delta",
        delta=SimpleNamespace(stop_reason=stop_reason),
        usage=SimpleNamespace(**usage_fields),
    )


async def _async_events(*events: SimpleNamespace) -> AsyncIterator[Any]:
    for event in events:
        yield event


async def test_iter_stream_events_maps_text_and_thinking_deltas() -> None:
    client = make_client()
    events = _async_events(
        _text_delta_event("Hello"),
        _thinking_delta_event("pondering"),
        _signature_delta_event("sig-abc"),
    )

    result = [event async for event in client._iter_stream_events(events, "claude-opus-4-6")]

    assert result == [
        TextDelta("Hello"),
        ThinkingDelta("pondering"),
        ThinkingPayloadDelta(
            model="claude-opus-4-6",
            payload=ThinkingPayload(kind="anthropic_signature", signature="sig-abc"),
        ),
    ]


async def test_iter_stream_events_redacted_thinking_pair() -> None:
    client = make_client()
    events = _async_events(_redacted_thinking_block_start_event("opaque-data"))

    result = [event async for event in client._iter_stream_events(events, "claude-opus-4-6")]

    assert result == [
        ThinkingDelta("[redacted thinking]"),
        ThinkingPayloadDelta(
            model="claude-opus-4-6",
            payload=ThinkingPayload(kind="anthropic_redacted", data="opaque-data"),
        ),
    ]


async def test_iter_stream_events_thinking_block_start_with_text() -> None:
    client = make_client()
    events = _async_events(_thinking_block_start_event("already here"))

    result = [event async for event in client._iter_stream_events(events, "claude-opus-4-6")]

    assert result == [ThinkingDelta("already here")]


async def test_iter_stream_events_merges_usage_across_deltas() -> None:
    client = make_client()
    events = _async_events(
        _message_start_event(
            input_tokens=10,
            output_tokens=1,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=2,
        ),
        _message_delta_event(
            "end_turn",
            output_tokens=42,
            input_tokens=None,
            cache_read_input_tokens=3,
            cache_creation_input_tokens=None,
        ),
    )

    result = [event async for event in client._iter_stream_events(events, "claude-opus-4-6")]

    assert result == [
        UsageDelta(
            Usage(input_tokens=10, output_tokens=1, cache_read_tokens=0, cache_write_tokens=2)
        ),
        UsageDelta(
            Usage(input_tokens=10, output_tokens=42, cache_read_tokens=3, cache_write_tokens=2)
        ),
    ]
    assert client.last_usage == Usage(
        input_tokens=10, output_tokens=42, cache_read_tokens=3, cache_write_tokens=2
    )


async def test_iter_stream_events_max_tokens_stop_reason_raises() -> None:
    client = make_client()
    events = _async_events(_message_delta_event("max_tokens", output_tokens=5))

    collected: list[Any] = []
    with pytest.raises(MaxTokensError):
        async for event in client._iter_stream_events(events, "claude-opus-4-6"):
            collected.append(event)

    assert collected == [UsageDelta(Usage(output_tokens=5))]


# --------------------------------------------------------------------------- #
# Content formatting
# --------------------------------------------------------------------------- #


def test_format_content_image_load_failure_falls_back_to_placeholder(tmp_path: Path) -> None:
    client = make_client()
    missing = tmp_path / "missing.png"
    blocks = client._format_content([ImageContent(path=str(missing))], base_dir=None)
    assert blocks == [{"type": "text", "text": f"[Failed to load image: {missing}]"}]


def test_format_content_skips_raw_thinking_without_signature() -> None:
    client = make_client()
    blocks = client._format_content(
        [ThinkingContent(value="raw reasoning", payload=None), TextContent(value="hello")],
        base_dir=None,
    )
    assert blocks == [{"type": "text", "text": "hello"}]


def test_format_content_emptied_message_gets_continuing_placeholder() -> None:
    client = make_client()
    blocks = client._format_content(
        [ThinkingContent(value="raw reasoning", payload=None)], base_dir=None
    )
    assert blocks == [{"type": "text", "text": "[continuing]"}]


def test_format_content_redacted_and_signature_payloads() -> None:
    client = make_client()
    blocks = client._format_content(
        [
            ThinkingContent(
                value="ignored", payload=ThinkingPayload(kind="anthropic_redacted", data="d1")
            ),
            ThinkingContent(
                value="ignored",
                payload=ThinkingPayload(kind="anthropic_signature", signature="s1"),
            ),
        ],
        base_dir=None,
    )
    assert blocks == [
        {"type": "redacted_thinking", "data": "d1"},
        {"type": "thinking", "thinking": "", "signature": "s1"},
    ]
