"""Tests for chatmd.providers.cleanup, a port of messageCleanup.ts.

One test per invariant documented in the module docstring, plus the
trailing-whitespace and cross-model-drop edge cases called out in the port spec.
"""

from __future__ import annotations

import pytest

from chatmd.providers.cleanup import (
    CONTINUING_PLACEHOLDER,
    _strip_trailing_whitespace,
    clean_messages_for_api,
    payload_usable_for_api,
    thinking_matches_model,
)
from chatmd.types import (
    ApiStyle,
    ImageContent,
    MessageParam,
    TextContent,
    ThinkingContent,
    ThinkingPayload,
)

# -- payload_usable_for_api ---------------------------------------------------------- #


@pytest.mark.parametrize(
    "api_style,kind,expected",
    [
        ("anthropic", "anthropic_signature", True),
        ("anthropic", "anthropic_redacted", True),
        ("anthropic", "openai_encrypted", False),
        ("anthropic", "reasoning_details", False),
        ("anthropic", "raw", False),
        ("openai_responses", "openai_encrypted", True),
        ("openai_responses", "anthropic_signature", False),
        ("openai_responses", "reasoning_details", False),
        ("openai_responses", "raw", False),
        ("openai_chat", "reasoning_details", True),
        ("openai_chat", "openai_encrypted", False),
        ("openai_chat", "anthropic_signature", False),
        ("openai_chat", "raw", False),
    ],
)
def test_payload_usable_for_api_mapping(api_style: ApiStyle, kind: str, expected: bool) -> None:
    block = ThinkingContent(value="x", payload=ThinkingPayload(kind=kind))  # type: ignore[arg-type]
    assert payload_usable_for_api(block, api_style) is expected


def test_payload_usable_for_api_no_payload_is_never_usable() -> None:
    block = ThinkingContent(value="raw thinking, no payload was ever recorded")
    assert payload_usable_for_api(block, "anthropic") is False


# -- thinking_matches_model ----------------------------------------------------------- #


def test_thinking_matches_model_no_attribution_always_matches() -> None:
    block = ThinkingContent(value="hand written or pre-feature thought")
    assert thinking_matches_model(block, "claude-x") is True
    assert thinking_matches_model(block, "claude-y") is True


def test_thinking_matches_model_same_model() -> None:
    block = ThinkingContent(value="t", model="claude-x")
    assert thinking_matches_model(block, "claude-x") is True


def test_thinking_matches_model_different_model() -> None:
    block = ThinkingContent(value="t", model="claude-x")
    assert thinking_matches_model(block, "claude-y") is False


# -- invariant: message count never changes; emptied messages get a placeholder ----- #


def test_message_count_never_changes_and_emptied_message_gets_placeholder() -> None:
    messages = [
        MessageParam(role="user", content=[TextContent(value="hello")]),
        MessageParam(role="assistant", content=[TextContent(value="   ")]),  # all blank
        MessageParam(role="user", content=[TextContent(value="bye")]),
    ]
    result = clean_messages_for_api(
        messages, model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    assert len(result) == len(messages)
    assert result[1].content == [TextContent(value=CONTINUING_PLACEHOLDER)]


def test_message_with_only_disabled_thinking_becomes_continuing_placeholder() -> None:
    message = MessageParam(
        role="assistant", content=[ThinkingContent(value="t", model="claude-x")]
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=False, api_style="anthropic"
    )
    assert result.content == [TextContent(value=CONTINUING_PLACEHOLDER)]


# -- invariant: at most one thinking block survives, moved to the front ------------- #


def test_at_most_one_thinking_block_survives_and_moves_to_front() -> None:
    message = MessageParam(
        role="assistant",
        content=[
            TextContent(value="hello"),
            ThinkingContent(value="first thought", model="claude-x"),
            ThinkingContent(value="second thought", model="claude-x"),
            TextContent(value="world"),
        ],
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    thinking_blocks = [b for b in result.content if isinstance(b, ThinkingContent)]
    assert len(thinking_blocks) == 1
    assert isinstance(result.content[0], ThinkingContent)
    assert result.content[0].value == "first thought"
    assert result.content[1:] == [TextContent(value="hello"), TextContent(value="world")]


# -- invariant: thinking from a different model, or an unreplayable payload, is ----- #
# -- dropped (payload only -- raw text may survive) --------------------------------- #


def test_thinking_from_different_model_is_dropped_entirely() -> None:
    message = MessageParam(
        role="assistant",
        content=[
            ThinkingContent(value="secret plan", model="claude-old"),
            TextContent(value="answer"),
        ],
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-new", thinking_enabled=True, api_style="anthropic"
    )
    assert not any(isinstance(b, ThinkingContent) for b in result.content)
    assert result.content == [TextContent(value="answer")]


def test_payload_unusable_for_target_api_drops_payload_but_keeps_raw_text() -> None:
    # Same model, but e.g. it was recorded against the OpenAI Responses API and this
    # request is going to Anthropic -- the encrypted payload cannot be replayed there.
    block = ThinkingContent(
        value="reasoning text",
        model="claude-x",
        hash="deadbeef",
        payload=ThinkingPayload(kind="openai_encrypted", encrypted_content="abc"),
    )
    message = MessageParam(role="assistant", content=[block, TextContent(value="answer")])
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    survivor = result.content[0]
    assert isinstance(survivor, ThinkingContent)
    assert survivor.value == "reasoning text"
    assert survivor.payload is None
    assert survivor.hash is None


def test_usable_opaque_payload_survives_with_text_cleared() -> None:
    payload = ThinkingPayload(kind="anthropic_signature", signature="sig123")
    block = ThinkingContent(
        value="reasoning text", model="claude-x", hash="abc12345", payload=payload
    )
    message = MessageParam(role="assistant", content=[block])
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    survivor = result.content[0]
    assert isinstance(survivor, ThinkingContent)
    # The API will replay the opaque payload, so the readable text is irrelevant.
    assert survivor.value == ""
    assert survivor.payload == payload
    assert survivor.hash == "abc12345"


def test_no_opaque_payload_blank_candidate_text_is_dropped() -> None:
    message = MessageParam(
        role="assistant",
        content=[ThinkingContent(value="   ", model="claude-x"), TextContent(value="answer")],
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    assert result.content == [TextContent(value="answer")]


# -- thinking blocks on a user message, or when thinking is disabled, are dropped --- #


def test_thinking_on_user_message_is_dropped() -> None:
    message = MessageParam(
        role="user",
        content=[
            ThinkingContent(value="stray thought", model="claude-x"),
            TextContent(value="hi"),
        ],
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    assert result.content == [TextContent(value="hi")]


def test_thinking_dropped_when_disabled_even_for_assistant() -> None:
    message = MessageParam(
        role="assistant",
        content=[ThinkingContent(value="thought", model="claude-x"), TextContent(value="answer")],
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=False, api_style="anthropic"
    )
    assert result.content == [TextContent(value="answer")]


# -- blank text blocks are filtered out first ---------------------------------------- #


def test_blank_text_blocks_filtered_out_first() -> None:
    message = MessageParam(
        role="user",
        content=[TextContent(value="  \n\t "), TextContent(value="real content")],
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    assert result.content == [TextContent(value="real content")]


# -- trailing whitespace on the final assistant text block -------------------------- #


def test_trailing_whitespace_stripped_from_final_assistant_text_block() -> None:
    message = MessageParam(
        role="assistant",
        content=[TextContent(value="hello"), TextContent(value="world   \n\t")],
    )
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    assert result.content == [TextContent(value="hello"), TextContent(value="world")]


def test_trailing_whitespace_not_touched_for_user_messages() -> None:
    # stripTrailingWhitespace only runs for the assistant role.
    message = MessageParam(role="user", content=[TextContent(value="world   \n\t")])
    [result] = clean_messages_for_api(
        [message], model_name="claude-x", thinking_enabled=True, api_style="anthropic"
    )
    assert result.content == [TextContent(value="world   \n\t")]


def test_strip_trailing_whitespace_removes_blank_trailing_blocks_and_continues() -> None:
    # Exercises the helper directly: clean_messages_for_api's own blank-text filter
    # normally removes whitespace-only blocks earlier, so this covers the "remove
    # entirely, then continue to the block before it" branch on its own terms.
    blocks = [
        TextContent(value="keep me"),
        TextContent(value="   "),
        TextContent(value="\n\t"),
    ]
    result = _strip_trailing_whitespace(blocks)
    assert result == [TextContent(value="keep me")]


def test_strip_trailing_whitespace_stops_at_first_non_text_block() -> None:
    blocks = [TextContent(value="hello   "), ImageContent(path="x.png")]
    result = _strip_trailing_whitespace(blocks)
    assert result == blocks
