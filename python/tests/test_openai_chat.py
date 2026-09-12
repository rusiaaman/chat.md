"""Tests for chatmd.providers.openai_chat, a port of openaiClient.ts.

No network I/O and no real SDK client is constructed: request shaping and message
formatting are exercised through pure functions, and stream translation is fed a
fake async iterator of chunk-shaped ``SimpleNamespace`` stubs.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from chatmd.providers.base import MaxTokensError
from chatmd.providers.openai_chat import (
    ReasoningDetailsAccumulator,
    _translate_stream,
    build_request_kwargs,
    format_message,
)
from chatmd.types import (
    ImageContent,
    MessageParam,
    TextContent,
    TextDelta,
    ThinkingContent,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    Usage,
    UsageDelta,
)

# -- build_request_kwargs ------------------------------------------------------------ #


def test_build_request_uses_max_completion_tokens_not_max_tokens() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4o",
        system_prompt="be nice",
        formatted_messages=[],
        max_tokens=1234,
        reasoning_effort=None,
    )
    assert kwargs["max_completion_tokens"] == 1234
    assert "max_tokens" not in kwargs


def test_build_request_sets_stream_options() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4o",
        system_prompt="be nice",
        formatted_messages=[],
        max_tokens=100,
        reasoning_effort=None,
    )
    assert kwargs["stream"] is True
    assert kwargs["stream_options"] == {"include_usage": True}


def test_build_request_omits_reasoning_effort_when_not_configured() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4o",
        system_prompt="be nice",
        formatted_messages=[],
        max_tokens=100,
        reasoning_effort=None,
    )
    assert "reasoning_effort" not in kwargs


@pytest.mark.parametrize("effort", ["low", "medium", "high", "max", "minimal", "none"])
def test_build_request_includes_reasoning_effort_when_configured(effort: Any) -> None:
    # "none" is included too: the TS client's `if (reasoningEffort)` truthiness
    # check treats the literal string "none" the same as any other configured value.
    kwargs = build_request_kwargs(
        model="gpt-4o",
        system_prompt="be nice",
        formatted_messages=[],
        max_tokens=100,
        reasoning_effort=effort,
    )
    assert kwargs["reasoning_effort"] == effort


def test_build_request_system_message_leads() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4o",
        system_prompt="be nice",
        formatted_messages=[{"role": "user", "content": "hi"}],
        max_tokens=100,
        reasoning_effort=None,
    )
    messages = kwargs["messages"]
    assert messages[0] == {"role": "system", "content": "be nice"}
    assert messages[1] == {"role": "user", "content": "hi"}


# -- format_message / message formatting ---------------------------------------------- #


def test_format_message_text_only_collapses_to_string() -> None:
    message = MessageParam(
        role="user", content=[TextContent(value="first"), TextContent(value="second")]
    )
    formatted = format_message(message)
    assert formatted["content"] == "first\n\nsecond"


def test_format_message_mixed_content_becomes_array(tmp_path: Any) -> None:
    image_path = tmp_path / "pic.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nrest-of-file")
    message = MessageParam(
        role="user",
        content=[TextContent(value="look at this"), ImageContent(path=str(image_path))],
    )
    formatted = format_message(message)
    content = formatted["content"]
    assert content[0] == {"type": "text", "text": "look at this"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_format_message_unreadable_image_falls_back_to_placeholder(tmp_path: Any) -> None:
    missing_path = str(tmp_path / "does-not-exist.png")
    message = MessageParam(
        role="user",
        content=[TextContent(value="see"), ImageContent(path=missing_path)],
    )
    formatted = format_message(message)
    content = formatted["content"]
    assert content[1] == {"type": "text", "text": f"[Failed to load image: {missing_path}]"}


def test_format_message_reasoning_details_go_to_top_level_field() -> None:
    payload = ThinkingPayload(kind="reasoning_details", reasoning_details=[{"type": "x"}])
    message = MessageParam(
        role="assistant",
        content=[
            ThinkingContent(value="ignored text", payload=payload),
            TextContent(value="hello"),
        ],
    )
    formatted = format_message(message)
    assert formatted["reasoning_details"] == [{"type": "x"}]
    assert "reasoning_content" not in formatted
    assert formatted["content"] == "hello"


def test_format_message_raw_thinking_goes_to_recorded_field_name() -> None:
    payload = ThinkingPayload(kind="raw", reasoning_field="reasoning_summary")
    message = MessageParam(
        role="assistant",
        content=[ThinkingContent(value="thinking text", payload=payload), TextContent(value="hi")],
    )
    formatted = format_message(message)
    assert formatted["reasoning_summary"] == "thinking text"
    assert "reasoning_details" not in formatted


def test_format_message_default_reasoning_field_is_reasoning_content() -> None:
    message = MessageParam(
        role="assistant",
        content=[ThinkingContent(value="thinking text, no payload"), TextContent(value="hi")],
    )
    formatted = format_message(message)
    assert formatted["reasoning_content"] == "thinking text, no payload"


# -- ReasoningDetailsAccumulator ------------------------------------------------------- #


def test_accumulator_id_keyed_merge_concatenates_text() -> None:
    acc = ReasoningDetailsAccumulator()
    acc.process_delta({"type": "reasoning.summary", "id": "r1", "text": "Hel"})
    acc.process_delta({"type": "reasoning.summary", "id": "r1", "text": "lo"})
    details = acc.get_details()
    assert len(details) == 1
    assert details[0]["text"] == "Hello"


def test_accumulator_index_keyed_entries_stay_separate() -> None:
    acc = ReasoningDetailsAccumulator()
    acc.process_delta({"type": "reasoning.summary", "index": 0, "text": "a"})
    acc.process_delta({"type": "reasoning.summary", "index": 1, "text": "b"})
    acc.process_delta({"type": "reasoning.summary", "index": 0, "text": "c"})
    details = acc.get_details()
    assert len(details) == 2
    assert details[0]["text"] == "ac"
    assert details[1]["text"] == "b"


def test_accumulator_position_keyed_fallback_when_no_id_or_index() -> None:
    acc = ReasoningDetailsAccumulator()
    acc.process_delta({"type": "reasoning.summary", "text": "first"})
    acc.process_delta({"type": "reasoning.summary", "text": "second"})
    details = acc.get_details()
    # Neither carries an id or index, so each gets its own positional key.
    assert len(details) == 2
    assert details[0]["text"] == "first"
    assert details[1]["text"] == "second"


def test_accumulator_non_text_fields_overwrite_rather_than_concatenate() -> None:
    acc = ReasoningDetailsAccumulator()
    acc.process_delta({"type": "reasoning.summary", "id": "r1", "signature": "sig-1"})
    acc.process_delta({"type": "reasoning.summary", "id": "r1", "signature": "sig-2"})
    details = acc.get_details()
    assert details[0]["signature"] == "sig-2"


def test_accumulator_display_text_prefers_text_then_summary() -> None:
    acc = ReasoningDetailsAccumulator()
    assert acc.process_delta({"type": "x", "text": "the text"}) == "the text"
    assert acc.process_delta({"type": "y", "summary": "the summary"}) == "the summary"
    assert acc.process_delta({"type": "z"}) == ""


# -- _translate_stream ------------------------------------------------------------------ #


def _chunk(
    *,
    content: str | None = None,
    finish_reason: str | None = None,
    usage: Any | None = None,
    **delta_extra: Any,
) -> SimpleNamespace:
    delta = SimpleNamespace(content=content, **delta_extra)
    choice = SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice], usage=usage)


async def _aiter(items: list[Any]) -> Any:
    for item in items:
        yield item


async def test_translate_stream_reasoning_then_content_ordering() -> None:
    chunks = [
        _chunk(content=None, reasoning_content="thinking..."),
        _chunk(content="Hello"),
    ]
    events = [event async for event in _translate_stream(_aiter(chunks), "gpt-4o", [])]
    assert events == [
        ThinkingDelta(text="thinking..."),
        ThinkingPayloadDelta(
            model="gpt-4o", payload=ThinkingPayload(kind="raw", reasoning_field="reasoning_content")
        ),
        TextDelta(text="Hello"),
    ]


async def test_translate_stream_duplicate_reasoning_text_emitted_once() -> None:
    # OpenRouter-style chunk: identical reasoning in both reasoning_content and
    # reasoning_details. Only the flat-text field's emission should survive.
    chunks = [
        _chunk(
            content=None,
            reasoning_content="dup text",
            reasoning_details=[{"type": "reasoning.text", "id": "r1", "text": "dup text"}],
        ),
        _chunk(content="done"),
    ]
    events = [event async for event in _translate_stream(_aiter(chunks), "gpt-4o", [])]
    thinking_events = [e for e in events if isinstance(e, ThinkingDelta)]
    assert thinking_events == [ThinkingDelta(text="dup text")]

    payload_events = [e for e in events if isinstance(e, ThinkingPayloadDelta)]
    assert len(payload_events) == 1
    assert payload_events[0].payload.kind == "reasoning_details"
    assert payload_events[0].payload.reasoning_details == [
        {"type": "reasoning.text", "id": "r1", "text": "dup text"}
    ]


async def test_translate_stream_reasoning_run_closed_by_end_of_stream() -> None:
    chunks = [_chunk(content=None, reasoning_content="never followed by content")]
    events = [event async for event in _translate_stream(_aiter(chunks), "gpt-4o", [])]
    assert events[-1] == ThinkingPayloadDelta(
        model="gpt-4o",
        payload=ThinkingPayload(kind="raw", reasoning_field="reasoning_content"),
    )


async def test_translate_stream_usage_merges_across_chunks() -> None:
    usage1 = SimpleNamespace(prompt_tokens=10, completion_tokens=None, prompt_tokens_details=None)
    details2 = SimpleNamespace(cached_tokens=3)
    usage2 = SimpleNamespace(prompt_tokens=10, completion_tokens=5, prompt_tokens_details=details2)
    chunks = [
        _chunk(content="hi", usage=usage1),
        _chunk(content=None, finish_reason="stop", usage=usage2),
    ]
    events = [event async for event in _translate_stream(_aiter(chunks), "gpt-4o", [])]
    usage_events = [e for e in events if isinstance(e, UsageDelta)]
    assert len(usage_events) == 2
    final = usage_events[-1].usage
    assert final == Usage(input_tokens=10, output_tokens=5, cache_read_tokens=3)


async def test_translate_stream_length_finish_reason_raises_after_final_token() -> None:
    chunks = [_chunk(content="last bit", finish_reason="length")]

    events: list[Any] = []
    with pytest.raises(MaxTokensError):
        async for event in _translate_stream(_aiter(chunks), "gpt-4o", []):
            events.append(event)

    assert events == [TextDelta(text="last bit")]
