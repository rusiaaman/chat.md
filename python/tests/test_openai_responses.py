"""Tests for chatmd.providers.openai_responses, a port of openaiResponsesClient.ts.

No network I/O and no real SDK client is constructed: request shaping and input
conversion are exercised through pure functions, and stream translation is fed a
fake async iterator of ``SimpleNamespace`` event stubs -- the translation layer
dispatches on ``event.type`` (mirroring the TS client's ``switch (data.type)``)
rather than on the SDK's typed pydantic event classes, so stand-ins work directly.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from chatmd.providers.base import MaxTokensError
from chatmd.providers.openai_responses import (
    build_request_kwargs,
    convert_to_responses_input,
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

# We reach into the client's private _translate_stream the same way
# test_anthropic_client.py reaches into AnthropicClient's private helpers.
from chatmd.config.model import ResolvedConfig
from chatmd.providers.openai_responses import OpenAIResponsesClient


def make_client(**overrides: Any) -> OpenAIResponsesClient:
    config = ResolvedConfig(
        provider="openai",
        api_key="test-key",
        model_name=overrides.pop("model_name", "gpt-4.1"),
        reasoning_effort=overrides.pop("reasoning_effort", "none"),
        **overrides,
    )
    return OpenAIResponsesClient(config)


# --------------------------------------------------------------------------- #
# build_request_kwargs
# --------------------------------------------------------------------------- #


def test_build_request_is_stateless() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4.1",
        input_items=[],
        instructions="be nice",
        max_output_tokens=100,
        thinking_enabled=False,
        reasoning_effort=None,
    )
    assert kwargs["store"] is False


def test_build_request_instructions_carries_system_prompt() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4.1",
        input_items=[],
        instructions="be nice",
        max_output_tokens=100,
        thinking_enabled=False,
        reasoning_effort=None,
    )
    assert kwargs["instructions"] == "be nice"
    # The system prompt never appears as a message item in the Responses API.
    assert kwargs["input"] == []


def test_build_request_max_output_tokens_from_config() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4.1",
        input_items=[],
        instructions="sys",
        max_output_tokens=4321,
        thinking_enabled=False,
        reasoning_effort=None,
    )
    assert kwargs["max_output_tokens"] == 4321
    assert kwargs["stream"] is True


def test_build_request_thinking_enabled_sets_reasoning_and_include() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4.1",
        input_items=[],
        instructions="sys",
        max_output_tokens=100,
        thinking_enabled=True,
        reasoning_effort="high",
    )
    assert kwargs["reasoning"] == {"summary": "auto", "effort": "high"}
    # Without this, encrypted reasoning cannot be replayed on later turns.
    assert kwargs["include"] == ["reasoning.encrypted_content"]


def test_build_request_thinking_enabled_without_effort_omits_effort() -> None:
    kwargs = build_request_kwargs(
        model="gpt-4.1",
        input_items=[],
        instructions="sys",
        max_output_tokens=100,
        thinking_enabled=True,
        reasoning_effort=None,
    )
    assert kwargs["reasoning"] == {"summary": "auto"}
    assert kwargs["include"] == ["reasoning.encrypted_content"]


def test_build_request_thinking_disabled_omits_reasoning_and_include() -> None:
    # reasoning_effort == "none" means thinking_enabled is False by the time this
    # pure function is called; both keys must be entirely absent.
    kwargs = build_request_kwargs(
        model="gpt-4.1",
        input_items=[],
        instructions="sys",
        max_output_tokens=100,
        thinking_enabled=False,
        reasoning_effort=None,
    )
    assert "reasoning" not in kwargs
    assert "include" not in kwargs


def test_build_request_falls_back_to_default_model() -> None:
    client = make_client(model_name=None)
    assert client.config.model_name is None
    from chatmd.providers.openai_responses import DEFAULT_MODEL

    assert DEFAULT_MODEL == "gpt-4.1-mini"


# --------------------------------------------------------------------------- #
# convert_to_responses_input
# --------------------------------------------------------------------------- #


def test_convert_reasoning_item_precedes_its_assistant_message() -> None:
    payload = ThinkingPayload(kind="openai_encrypted", item_id="rs_1", encrypted_content="enc")
    message = MessageParam(
        role="assistant",
        content=[ThinkingContent(value="pondering", payload=payload), TextContent(value="hi")],
    )
    items = convert_to_responses_input([message])
    assert len(items) == 2
    assert items[0] == {
        "id": "rs_1",
        "type": "reasoning",
        "summary": [],
        "encrypted_content": "enc",
    }
    assert items[1] == {
        "role": "assistant",
        "content": [{"type": "output_text", "text": "hi", "annotations": []}],
    }


def test_convert_raw_thinking_text_is_skipped() -> None:
    # No payload at all: nothing replayable exists for it in this API.
    message = MessageParam(
        role="assistant",
        content=[ThinkingContent(value="raw reasoning", payload=None), TextContent(value="hi")],
    )
    items = convert_to_responses_input([message])
    assert items == [
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "hi", "annotations": []}],
        }
    ]


def test_convert_assistant_message_with_only_thinking_yields_one_item() -> None:
    payload = ThinkingPayload(kind="openai_encrypted", item_id="rs_2", encrypted_content="enc2")
    message = MessageParam(
        role="assistant", content=[ThinkingContent(value="pondering", payload=payload)]
    )
    items = convert_to_responses_input([message])
    assert items == [
        {"id": "rs_2", "type": "reasoning", "summary": [], "encrypted_content": "enc2"}
    ]


def test_convert_assistant_image_becomes_placeholder_text() -> None:
    message = MessageParam(role="assistant", content=[ImageContent(path="/tmp/pic.png")])
    items = convert_to_responses_input([message])
    assert items == [
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "[Assistant Image]", "annotations": []}],
        }
    ]


def test_convert_user_text_becomes_input_text() -> None:
    message = MessageParam(role="user", content=[TextContent(value="hello")])
    items = convert_to_responses_input([message])
    assert items == [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}]


def test_convert_user_image_becomes_input_image_with_data_url(tmp_path: Any) -> None:
    image_path = tmp_path / "pic.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nrest-of-file")
    message = MessageParam(role="user", content=[ImageContent(path=str(image_path))])
    items = convert_to_responses_input([message])
    assert len(items) == 1
    content = items[0]["content"]
    assert content[0]["type"] == "input_image"
    assert content[0]["image_url"].startswith("data:image/png;base64,")


def test_convert_unreadable_user_image_falls_back_to_placeholder(tmp_path: Any) -> None:
    missing_path = str(tmp_path / "does-not-exist.png")
    message = MessageParam(role="user", content=[ImageContent(path=missing_path)])
    items = convert_to_responses_input([message])
    assert items == [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": f"[Failed to load image: {missing_path}]"}
            ],
        }
    ]


def test_convert_user_message_with_no_parts_is_skipped() -> None:
    message = MessageParam(role="user", content=[TextContent(value="   ")])
    items = convert_to_responses_input([message])
    assert items == []


def test_convert_assistant_message_with_no_text_and_no_reasoning_is_skipped() -> None:
    message = MessageParam(role="assistant", content=[TextContent(value="")])
    items = convert_to_responses_input([message])
    assert items == []


def test_convert_encrypted_payload_missing_item_id_is_skipped() -> None:
    # Missing itemId means there's nothing to anchor a reasoning item to; emitting
    # one anyway would produce a malformed item the API would reject.
    payload = ThinkingPayload(kind="openai_encrypted", item_id=None, encrypted_content="enc")
    message = MessageParam(
        role="assistant",
        content=[ThinkingContent(value="pondering", payload=payload), TextContent(value="hi")],
    )
    items = convert_to_responses_input([message])
    assert items == [
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "hi", "annotations": []}],
        }
    ]


def test_convert_encrypted_payload_missing_encrypted_content_is_skipped() -> None:
    payload = ThinkingPayload(kind="openai_encrypted", item_id="rs_3", encrypted_content=None)
    message = MessageParam(role="assistant", content=[ThinkingContent(value="p", payload=payload)])
    items = convert_to_responses_input([message])
    assert items == []


# --------------------------------------------------------------------------- #
# Stream translation
# --------------------------------------------------------------------------- #


def _text_delta_event(delta: str) -> SimpleNamespace:
    return SimpleNamespace(type="response.output_text.delta", delta=delta)


def _reasoning_summary_delta_event(delta: str) -> SimpleNamespace:
    return SimpleNamespace(type="response.reasoning_summary_text.delta", delta=delta)


def _reasoning_text_delta_event(delta: str) -> SimpleNamespace:
    return SimpleNamespace(type="response.reasoning_text.delta", delta=delta)


def _reasoning_item_done_event(item_id: str, encrypted_content: str | None) -> SimpleNamespace:
    item = SimpleNamespace(type="reasoning", id=item_id, encrypted_content=encrypted_content)
    return SimpleNamespace(type="response.output_item.done", item=item)


def _message_item_done_event() -> SimpleNamespace:
    item = SimpleNamespace(type="message", id="msg_1")
    return SimpleNamespace(type="response.output_item.done", item=item)


def _usage_event(event_type: str, **usage_fields: Any) -> SimpleNamespace:
    usage = SimpleNamespace(**usage_fields)
    response = SimpleNamespace(usage=usage)
    return SimpleNamespace(type=event_type, response=response)


def _incomplete_event(reason: str | None) -> SimpleNamespace:
    incomplete_details = SimpleNamespace(reason=reason) if reason is not None else None
    response = SimpleNamespace(incomplete_details=incomplete_details, usage=None)
    return SimpleNamespace(type="response.incomplete", response=response)


def _failed_event(message: str) -> SimpleNamespace:
    error = SimpleNamespace(message=message)
    response = SimpleNamespace(error=error, usage=None)
    return SimpleNamespace(type="response.failed", response=response)


def _error_event(message: str) -> SimpleNamespace:
    return SimpleNamespace(type="error", message=message)


async def _aiter(items: list[Any]) -> Any:
    for item in items:
        yield item


async def test_translate_stream_text_delta() -> None:
    client = make_client()
    events = [e async for e in client._translate_stream(_aiter([_text_delta_event("Hi")]), "m")]
    assert events == [TextDelta(text="Hi")]


async def test_translate_stream_reasoning_summary_delta() -> None:
    client = make_client()
    events = [
        e
        async for e in client._translate_stream(
            _aiter([_reasoning_summary_delta_event("pondering")]), "m"
        )
    ]
    assert events == [ThinkingDelta(text="pondering")]


async def test_translate_stream_reasoning_text_delta() -> None:
    client = make_client()
    events = [
        e
        async for e in client._translate_stream(
            _aiter([_reasoning_text_delta_event("more pondering")]), "m"
        )
    ]
    assert events == [ThinkingDelta(text="more pondering")]


async def test_translate_stream_reasoning_item_done_yields_payload() -> None:
    client = make_client()
    events = [
        e
        async for e in client._translate_stream(
            _aiter([_reasoning_item_done_event("rs_1", "encrypted-blob")]), "gpt-4.1"
        )
    ]
    assert events == [
        ThinkingPayloadDelta(
            model="gpt-4.1",
            payload=ThinkingPayload(
                kind="openai_encrypted", item_id="rs_1", encrypted_content="encrypted-blob"
            ),
        )
    ]


async def test_translate_stream_reasoning_item_done_without_encrypted_content_yields_nothing() -> (
    None
):
    client = make_client()
    events = [
        e
        async for e in client._translate_stream(
            _aiter([_reasoning_item_done_event("rs_1", None)]), "gpt-4.1"
        )
    ]
    assert events == []


async def test_translate_stream_non_reasoning_item_done_yields_nothing() -> None:
    client = make_client()
    events = [
        e async for e in client._translate_stream(_aiter([_message_item_done_event()]), "gpt-4.1")
    ]
    assert events == []


async def test_translate_stream_usage_merges_across_events() -> None:
    client = make_client()
    events = [
        e
        async for e in client._translate_stream(
            _aiter(
                [
                    _usage_event(
                        "response.completed",
                        input_tokens=10,
                        output_tokens=None,
                        input_tokens_details=None,
                    ),
                    _usage_event(
                        "response.completed",
                        input_tokens=10,
                        output_tokens=5,
                        input_tokens_details=SimpleNamespace(cached_tokens=3),
                    ),
                ]
            ),
            "gpt-4.1",
        )
    ]
    usage_events = [e for e in events if isinstance(e, UsageDelta)]
    assert len(usage_events) == 2
    assert usage_events[-1].usage == Usage(input_tokens=10, output_tokens=5, cache_read_tokens=3)
    assert client.last_usage == Usage(input_tokens=10, output_tokens=5, cache_read_tokens=3)


async def test_translate_stream_incomplete_max_output_tokens_raises() -> None:
    client = make_client()
    with pytest.raises(MaxTokensError):
        async for _ in client._translate_stream(
            _aiter([_incomplete_event("max_output_tokens")]), "gpt-4.1"
        ):
            pass


async def test_translate_stream_incomplete_other_reason_does_not_raise() -> None:
    client = make_client()
    events = [
        e
        async for e in client._translate_stream(
            _aiter([_incomplete_event("content_filter")]), "gpt-4.1"
        )
    ]
    assert events == []


async def test_translate_stream_response_failed_raises_with_provider_message() -> None:
    client = make_client()
    with pytest.raises(RuntimeError, match="boom"):
        async for _ in client._translate_stream(_aiter([_failed_event("boom")]), "gpt-4.1"):
            pass


async def test_translate_stream_error_event_raises_with_provider_message() -> None:
    client = make_client()
    with pytest.raises(RuntimeError, match="kaboom"):
        async for _ in client._translate_stream(_aiter([_error_event("kaboom")]), "gpt-4.1"):
            pass


# --------------------------------------------------------------------------- #
# Error classification
# --------------------------------------------------------------------------- #


class _FakeResponsesEndpoint:
    """Stands in for ``client.responses`` -- ``create`` raises before streaming."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def create(self, **kwargs: Any) -> Any:
        raise self._error


def _make_status_error(status_code: int) -> Exception:
    import openai

    request = SimpleNamespace()
    response = SimpleNamespace(request=request, headers={})
    if status_code == 429:
        return openai.RateLimitError(
            message="rate limited", response=response, body=None  # type: ignore[arg-type]
        )
    return openai.APIStatusError(
        message="status error", response=response, body=None  # type: ignore[arg-type]
    )


async def test_stream_maps_500_to_retryable_error() -> None:
    from chatmd.providers.base import RetryableError

    client = make_client()
    error = _make_status_error(500)
    error.status_code = 500  # type: ignore[attr-defined]
    client._client.responses = _FakeResponsesEndpoint(error)  # type: ignore[attr-defined]

    with pytest.raises(RetryableError):
        async for _ in client.stream([], "sys"):
            pass


async def test_stream_maps_429_to_retryable_error() -> None:
    from chatmd.providers.base import RetryableError

    client = make_client()
    error = _make_status_error(429)
    error.status_code = 429  # type: ignore[attr-defined]
    client._client.responses = _FakeResponsesEndpoint(error)  # type: ignore[attr-defined]

    with pytest.raises(RetryableError):
        async for _ in client.stream([], "sys"):
            pass


async def test_stream_400_propagates_unchanged() -> None:
    client = make_client()
    error = _make_status_error(400)
    error.status_code = 400  # type: ignore[attr-defined]
    client._client.responses = _FakeResponsesEndpoint(error)  # type: ignore[attr-defined]

    import openai

    with pytest.raises(openai.APIStatusError):
        async for _ in client.stream([], "sys"):
            pass
