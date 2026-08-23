"""Tests for chatmd.render: assistant thinking/text sub-block parsing and rendering.

Port of the behaviour exercised by the TS `thinkingBlocks.ts` unit tests, adapted
to the StreamEvent object protocol used on the Python side instead of the
NUL-prefixed token strings the TS streamer relies on.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from chatmd.render import (
    TEXT_SECTION_MARKER,
    THINKING_SECTION_MARKER,
    AssistantSection,
    ParsedThinkingSection,
    SectionState,
    block_marker_prefix,
    format_signature_line,
    has_assistant_sections,
    parse_thinking_section,
    render_stream_events,
    split_assistant_sections,
    strip_thinking_sections,
)
from chatmd.types import (
    TextDelta,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    Usage,
    UsageDelta,
)

_PAYLOAD = ThinkingPayload(kind="anthropic_signature", signature="sig123")


def _recorder(result: str | None) -> Callable[[str, ThinkingPayload], str | None]:
    """A record_payload stub that always returns the same fixed result."""

    def record(model: str, payload: ThinkingPayload) -> str | None:
        return result

    return record


# --------------------------------------------------------------------------- #
# has_assistant_sections / split_assistant_sections
# --------------------------------------------------------------------------- #


def test_no_marker_is_plain_text() -> None:
    text = "just some plain assistant text\nwith multiple lines"
    assert has_assistant_sections(text) is False
    assert split_assistant_sections(text) == [AssistantSection(type="text", content=text)]


def test_leading_text_before_first_marker_is_kept() -> None:
    text = (
        "Leading text\n"
        "## %% thinking\n"
        "Thought here\n"
        "modelA::deadbeef\n"
        "## %% text\n"
        "Hello world\n"
    )
    assert has_assistant_sections(text) is True
    sections = split_assistant_sections(text)
    assert sections == [
        AssistantSection(type="text", content="Leading text\n"),
        AssistantSection(type="thinking", content="\nThought here\nmodelA::deadbeef\n"),
        AssistantSection(type="text", content="\nHello world\n"),
    ]


def test_blank_only_leading_content_is_dropped() -> None:
    # Whitespace before the first marker is not meaningful text, so no leading
    # section should be emitted for it.
    text = "   \n## %% thinking\nfoo\n## %% text\nbar\n"
    sections = split_assistant_sections(text)
    assert sections == [
        AssistantSection(type="thinking", content="\nfoo\n"),
        AssistantSection(type="text", content="\nbar\n"),
    ]


def test_markers_are_case_insensitive() -> None:
    text = "## %% THINKING\nfoo\n## %% Text\nbar\n"
    assert has_assistant_sections(text) is True
    sections = split_assistant_sections(text)
    # Regardless of the marker's casing in the source, the section kind is
    # normalized to the lowercase literal.
    assert [s.type for s in sections] == ["thinking", "text"]
    assert sections[0].content == "\nfoo\n"
    assert sections[1].content == "\nbar\n"


def test_only_text_markers_yields_only_text_sections() -> None:
    text = "## %% text\nfirst\n## %% text\nsecond\n"
    sections = split_assistant_sections(text)
    assert [s.type for s in sections] == ["text", "text"]


# --------------------------------------------------------------------------- #
# parse_thinking_section
# --------------------------------------------------------------------------- #


def test_parse_thinking_section_with_signature() -> None:
    parsed = parse_thinking_section("\nThought here\nmodelA::deadbeef\n")
    assert parsed == ParsedThinkingSection(text="Thought here", model="modelA", hash="deadbeef")


def test_parse_thinking_section_without_signature() -> None:
    content = "\nJust thinking, no signature line\n"
    parsed = parse_thinking_section(content)
    assert parsed == ParsedThinkingSection(text=content.strip(), model=None, hash=None)


def test_parse_thinking_section_all_blank() -> None:
    assert parse_thinking_section("   \n\n  ") == ParsedThinkingSection(text="")


def test_parse_thinking_section_model_name_contains_double_colon() -> None:
    # The model-part regex group is greedy, so splitting happens on the LAST
    # "::" in the line, leaving an embedded "::" as part of the model name.
    parsed = parse_thinking_section("\nSome thought\nprovider::modelname::deadbeef\n")
    assert parsed == ParsedThinkingSection(
        text="Some thought", model="provider::modelname", hash="deadbeef"
    )


@pytest.mark.parametrize(
    "last_line",
    [
        "modelA::deadbee",  # only 7 hex characters
        "modelA::DEADBEEF",  # uppercase hex is not accepted
        "modelA:deadbeef1",  # single colon, not "::"
        "::deadbeef",  # empty model part
    ],
)
def test_parse_thinking_section_rejects_non_matching_last_line(last_line: str) -> None:
    content = f"\nsome thought\n{last_line}\n"
    parsed = parse_thinking_section(content)
    assert parsed.model is None
    assert parsed.hash is None
    assert parsed.text == content.strip()


# --------------------------------------------------------------------------- #
# format_signature_line / strip_thinking_sections
# --------------------------------------------------------------------------- #


def test_format_signature_line() -> None:
    assert format_signature_line("modelA", "deadbeef") == "modelA::deadbeef"


def test_strip_thinking_sections_no_markers_returns_input_unchanged() -> None:
    text = "just plain text\nline2"
    assert strip_thinking_sections(text) == text


def test_strip_thinking_sections_drops_thinking_content() -> None:
    text = (
        "Leading text\n"
        "## %% thinking\n"
        "Thought here\n"
        "modelA::deadbeef\n"
        "## %% text\n"
        "Hello world\n"
    )
    assert strip_thinking_sections(text) == "Leading text\n\n\nHello world\n"


# --------------------------------------------------------------------------- #
# block_marker_prefix
# --------------------------------------------------------------------------- #


def test_block_marker_prefix_start_of_document() -> None:
    assert block_marker_prefix("") == ""


def test_block_marker_prefix_already_blank_line_above() -> None:
    assert block_marker_prefix("abc\n\n") == ""
    assert block_marker_prefix("abc\n   \n") == ""
    assert block_marker_prefix("abc\n\r\n") == ""


def test_block_marker_prefix_single_trailing_newline() -> None:
    assert block_marker_prefix("abc\n") == "\n"


def test_block_marker_prefix_no_trailing_newline() -> None:
    assert block_marker_prefix("abc") == "\n\n"


# --------------------------------------------------------------------------- #
# render_stream_events
# --------------------------------------------------------------------------- #


def test_render_plain_text_only_never_opens_sections() -> None:
    # A turn with no reasoning at all must stay in the pre-existing plain format:
    # no "## %% text" marker is ever introduced.
    state = SectionState()
    out = render_stream_events(
        [TextDelta("Hello "), TextDelta("world")], "", state, _recorder(None)
    )
    assert out == "Hello world"
    assert state == SectionState()


def test_render_usage_delta_is_ignored() -> None:
    state = SectionState()
    out = render_stream_events(
        [TextDelta("Hello "), UsageDelta(usage=Usage(input_tokens=5)), TextDelta("world")],
        "",
        state,
        _recorder(None),
    )
    assert out == "Hello world"
    assert state == SectionState()


def test_render_thinking_then_signature_then_text() -> None:
    state = SectionState()
    events = [
        ThinkingDelta("Let me think"),
        ThinkingPayloadDelta(model="modelA", payload=_PAYLOAD),
        TextDelta("Hello"),
    ]
    out = render_stream_events(events, "", state, _recorder("modelA::deadbeef"))

    assert out == (
        f"{THINKING_SECTION_MARKER}\nLet me think\nmodelA::deadbeef\n{TEXT_SECTION_MARKER}\nHello"
    )
    assert state.thinking_open is False
    assert state.text_open is True
    assert state.saw_thinking is True
    # scan_offset must land exactly after the "## %% text" marker, so a tool call
    # scan never sees the thinking text or its signature line above it.
    expected_scan_offset = len(
        f"{THINKING_SECTION_MARKER}\nLet me think\nmodelA::deadbeef\n{TEXT_SECTION_MARKER}\n"
    )
    assert state.scan_offset == expected_scan_offset
    assert out[state.scan_offset :] == "Hello"
    assert state.text_section_end is None


def test_render_payload_with_no_stored_signature_is_dropped() -> None:
    # record_payload returning None means the payload could not be stored: no
    # section is opened at all, and state stays untouched.
    state = SectionState()
    out = render_stream_events(
        [ThinkingPayloadDelta(model="modelA", payload=_PAYLOAD)], "", state, _recorder(None)
    )
    assert out == ""
    assert state == SectionState()


def test_render_append_only_reopens_a_new_thinking_section_after_text() -> None:
    # A signature ends a thinking section without ending reasoning: once text has
    # been written after it, further thinking must open ANOTHER "## %% thinking"
    # section rather than editing the first one back open.
    state = SectionState()
    events = [
        ThinkingDelta("T1"),
        ThinkingPayloadDelta(model="m", payload=_PAYLOAD),
        TextDelta("mid text"),
        ThinkingDelta("T2"),
    ]
    out = render_stream_events(events, "", state, _recorder("m::aaaaaaaa"))

    assert out.count(THINKING_SECTION_MARKER) == 2
    assert out == (
        f"{THINKING_SECTION_MARKER}\nT1\nm::aaaaaaaa\n"
        f"{TEXT_SECTION_MARKER}\nmid text\n"
        f"{THINKING_SECTION_MARKER}\nT2"
    )
    # The text section that was open when the second thinking section started is
    # exactly what got closed off - right where "mid text" ends.
    text_section_start = len(
        f"{THINKING_SECTION_MARKER}\nT1\nm::aaaaaaaa\n{TEXT_SECTION_MARKER}\n"
    )
    assert state.text_section_end == text_section_start + len("mid text")
    assert state.thinking_open is True
    assert state.text_open is False


def test_render_two_thinking_sections_back_to_back_collapses_scannable_region() -> None:
    # Simulate this batch arriving mid-turn: a previous batch already opened a
    # text section (scan_offset=12) which then closed without any further text
    # ever following it in the block (saw_thinking is already True, text_open is
    # already False). Two thinking sections now arrive back to back with no text
    # between them.
    already_written = "X" * 50
    state = SectionState(
        thinking_open=False, text_open=False, saw_thinking=True, scan_offset=12
    )
    events = [
        ThinkingDelta("A"),
        ThinkingPayloadDelta(model="m", payload=_PAYLOAD),
        ThinkingDelta("B"),
    ]
    render_stream_events(events, already_written, state, _recorder("m::bbbbbbbb"))

    # If this collapsed to `already_written + out` instead, it would have grown
    # past 50 and made the just-written first thinking section look scannable.
    # It must instead stay pinned to the old scan_offset.
    assert state.text_section_end == 12
    assert state.scan_offset == 12


def test_render_two_thinking_sections_back_to_back_from_fresh_state() -> None:
    # Same shape as above but from a brand new SectionState: no text section has
    # ever existed, so "not saw_thinking" is what makes the *first* thinking
    # section's region collapse to 0 rather than to alreadyWritten+out.
    state = SectionState()
    events = [
        ThinkingDelta("First thought"),
        ThinkingPayloadDelta(model="modelA", payload=_PAYLOAD),
    ]
    render_stream_events(events, "", state, _recorder("modelA::11111111"))
    assert state.text_section_end == 0
    assert state.scan_offset == 0

    # A second thinking section starts immediately after, still with no text in
    # between: the region collapses again rather than covering the first section.
    render_stream_events([ThinkingDelta("Second thought")], "", state, _recorder(None))
    assert state.text_section_end == 0
    assert state.thinking_open is True


def test_render_needs_newline_before_marker_when_already_written_lacks_one() -> None:
    # already_written does not end in a newline, so the very first marker this
    # call writes must be preceded by one.
    state = SectionState()
    out = render_stream_events(
        [ThinkingDelta("hi")], "some prior text", state, _recorder(None)
    )
    assert out == f"\n{THINKING_SECTION_MARKER}\nhi"


def test_render_empty_thinking_delta_is_ignored() -> None:
    state = SectionState()
    out = render_stream_events([ThinkingDelta("")], "", state, _recorder(None))
    assert out == ""
    assert state == SectionState()
