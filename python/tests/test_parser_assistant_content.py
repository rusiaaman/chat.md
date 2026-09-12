"""Tests for chatmd.parser.assistant_content: parsing a ``# %% assistant`` block
into text and thinking content.

Port of ``parseAssistantContent`` and its ``appendWaitMarkerToLastToolCall`` helper
in TS ``src/parser.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path

from chatmd.assets import assets_dir
from chatmd.parser.assistant_content import parse_assistant_content
from chatmd.providers.native_tools import render_server_tool_result, render_tool_call
from chatmd.thinking_map import put_thinking_entry, thinking_map_path
from chatmd.tools.call_parser import (
    CMD_TOOL_CALL_CLOSE_TAG,
    CMD_TOOL_CALL_OPEN_TAG,
    CMD_WAIT_TOOL_RESULT_TAG,
)
from chatmd.tools.result_format import format_tool_result
from chatmd.types import (
    TextContent,
    ThinkingContent,
    ThinkingPayload,
    ToolResultContent,
    ToolUseContent,
)


def _tool_call(name: str) -> str:
    """A well-formed, multi-line ``<cmd:tool_call>`` for the given tool name."""
    return (
        f"{CMD_TOOL_CALL_OPEN_TAG}\n<cmd:tool_name>{name}</cmd:tool_name>\n"
        f"{CMD_TOOL_CALL_CLOSE_TAG}"
    )


# --------------------------------------------------------------------------- #
# No "## %%" marker at all: plain text
# --------------------------------------------------------------------------- #


def test_block_without_any_marker_is_plain_text() -> None:
    content = "Hello there, this is an ordinary assistant reply."
    assert parse_assistant_content(content) == [TextContent(value=content)]


def test_plain_text_block_is_stripped() -> None:
    assert parse_assistant_content("  \n  Hello  \n  ") == [TextContent(value="Hello")]


def test_whitespace_only_block_without_a_marker_produces_no_content() -> None:
    assert parse_assistant_content("   \n  ") == []


# --------------------------------------------------------------------------- #
# Thinking sections without a signature line
# --------------------------------------------------------------------------- #


def test_thinking_section_without_a_signature_line(tmp_path: Path) -> None:
    content = "## %% thinking\nJust reasoning out loud, no signature.\n## %% text\nAnswer.\n"
    result = parse_assistant_content(content, tmp_path)
    assert result == [
        ThinkingContent(value="Just reasoning out loud, no signature.", model=None, hash=None),
        TextContent(value="Answer."),
    ]


def test_empty_thinking_section_is_dropped_entirely() -> None:
    content = "## %% thinking\n   \n## %% text\nHello\n"
    assert parse_assistant_content(content) == [TextContent(value="Hello")]


# --------------------------------------------------------------------------- #
# Thinking sections WITH a signature line, resolved against a real thinking map
# --------------------------------------------------------------------------- #


def test_thinking_hash_resolves_against_a_real_thinking_map(tmp_path: Path) -> None:
    payload = ThinkingPayload(kind="anthropic_signature", signature="sig-xyz")
    hash_ = put_thinking_entry(assets_dir(tmp_path), "claude-x", payload)

    content = f"## %% thinking\nSome reasoning\nclaude-x::{hash_}\n## %% text\nFinal answer\n"
    result = parse_assistant_content(content, tmp_path)

    assert result == [
        ThinkingContent(value="Some reasoning", model="claude-x", hash=hash_, payload=payload),
        TextContent(value="Final answer"),
    ]


def test_the_model_on_thinking_content_comes_from_the_signature_line(tmp_path: Path) -> None:
    """The document is the record of truth: ThinkingContent.model is always what
    the signature line literally says, never the map entry's own "model" field --
    even when they happen to differ (e.g. a hash reused by hand, or a map entry
    someone edited)."""
    directory = assets_dir(tmp_path)
    directory.mkdir(parents=True, exist_ok=True)
    entries = {"aaaaaaaa": {"kind": "raw", "model": "storedModel", "createdAt": "2024-01-01"}}
    thinking_map_path(directory).write_text(
        json.dumps({"version": 1, "entries": entries}), encoding="utf-8"
    )

    content = "## %% thinking\nSome thought\ndifferentModel::aaaaaaaa\n"
    result = parse_assistant_content(content, tmp_path)

    assert len(result) == 1
    thinking = result[0]
    assert isinstance(thinking, ThinkingContent)
    assert thinking.model == "differentModel"
    assert thinking.payload is not None and thinking.payload.kind == "raw"


def test_hash_with_no_map_entry_degrades_to_display_only_without_raising(tmp_path: Path) -> None:
    # No thinking_map.json was ever written at all -- an absent map must degrade
    # gracefully rather than breaking the parse.
    content = "## %% thinking\nOrphan thought\nsomeModel::deadbeef\n"
    result = parse_assistant_content(content, tmp_path)
    assert result == [
        ThinkingContent(value="Orphan thought", model="someModel", hash="deadbeef", payload=None)
    ]


def test_hash_lookup_is_skipped_entirely_without_a_base_dir() -> None:
    content = "## %% thinking\nOrphan thought\nsomeModel::deadbeef\n"
    result = parse_assistant_content(content, base_dir=None)
    assert result == [
        ThinkingContent(value="Orphan thought", model="someModel", hash="deadbeef", payload=None)
    ]


# --------------------------------------------------------------------------- #
# append_wait_marker: last TEXT block only, never inside thinking
# --------------------------------------------------------------------------- #


def test_tool_call_is_parsed_as_structured_content() -> None:
    content = f"Before.\n{_tool_call('foo')}\n"
    result = parse_assistant_content(content)
    assert result[0] == TextContent(value="Before.")
    assert isinstance(result[1], ToolUseContent)
    assert result[1].name == "foo"
    assert result[1].raw_xml == _tool_call("foo")


def test_append_wait_marker_never_attaches_to_a_tool_call_written_inside_thinking() -> None:
    """A tool call that only appears inside a thinking section was never actually
    a call (thinking is never scanned for tool calls), so the end-of-batch marker
    must never land there even though the text is a syntactically complete call."""
    thinking_body = _tool_call("should_not_get_marker")
    content = (
        f"## %% thinking\n{thinking_body}\nmodelX::deadbeef\n"
        f"## %% text\nBefore.\n{_tool_call('real')}\n"
    )
    result = parse_assistant_content(content)

    assert len(result) == 3
    thinking, text, tool_use = result
    assert isinstance(thinking, ThinkingContent)
    assert CMD_WAIT_TOOL_RESULT_TAG not in thinking.value
    assert isinstance(text, TextContent)
    assert text.value == "Before."
    assert isinstance(tool_use, ToolUseContent)
    assert tool_use.name == "real"


def test_append_wait_marker_skips_a_trailing_text_block_with_no_tool_call() -> None:
    """The marker is attached to the last text block that actually CONTAINS a
    completed tool call, scanning backward past any trailing text section (e.g. a
    closing remark typed after the call) that has none."""
    content = (
        f"## %% text\nBefore.\n{_tool_call('real')}\n"
        "## %% text\nJust a trailing remark with no call.\n"
    )
    result = parse_assistant_content(content)

    assert len(result) == 3
    first, tool_use, second = result
    assert isinstance(first, TextContent)
    assert isinstance(second, TextContent)
    assert first.value == "Before."
    assert isinstance(tool_use, ToolUseContent)
    assert tool_use.name == "real"
    assert second.value == "Just a trailing remark with no call."


def test_append_wait_marker_is_a_no_op_when_no_tool_call_exists_anywhere() -> None:
    content = "Just a normal reply with no tool calls at all."
    result = parse_assistant_content(content)
    assert result == [TextContent(value=content)]


def test_tool_call_is_structured_without_an_execution_result() -> None:
    content = f"Before.\n{_tool_call('foo')}\n"
    result = parse_assistant_content(content)
    assert result[0] == TextContent(value="Before.")
    assert isinstance(result[1], ToolUseContent)
    assert result[1].name == "foo"


def test_server_results_use_ids_when_parallel_calls_finish_out_of_order() -> None:
    content = "\n".join(
        [
            "## %% server_tool",
            render_tool_call("call-1", "first", {}),
            "## %% server_tool",
            render_tool_call("call-2", "second", {}),
            "## %% server_tool_results",
            render_server_tool_result("call-2", format_tool_result("second result")),
            "## %% server_tool_results",
            render_server_tool_result("call-1", format_tool_result("first result")),
        ]
    )

    parsed = parse_assistant_content(content)
    results = [item for item in parsed if isinstance(item, ToolResultContent)]

    assert [(item.tool_use_id, item.name) for item in results] == [
        ("call-2", "second"),
        ("call-1", "first"),
    ]
