"""Tests for chatmd.parser.document: parsing a whole ``.chat.md`` document into a
message history.

Port of ``parseDocument`` in TS ``src/parser.ts``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from chatmd.errors import ForbiddenInlineConfigKey, InvalidStartContent
from chatmd.parser.document import parse_document
from chatmd.providers.native_tools import render_server_tool_result, render_tool_call
from chatmd.tools.call_parser import (
    CMD_TOOL_CALL_CLOSE_TAG,
    CMD_TOOL_CALL_OPEN_TAG,
    CMD_WAIT_TOOL_RESULT_TAG,
)
from chatmd.types import ImageContent, TextContent, ToolResultContent, ToolUseContent


def _tool_call(name: str) -> str:
    """A well-formed, multi-line ``<cmd:tool_call>`` for the given tool name."""
    return (
        f"{CMD_TOOL_CALL_OPEN_TAG}\n<cmd:tool_name>{name}</cmd:tool_name>\n"
        f"{CMD_TOOL_CALL_CLOSE_TAG}"
    )


# --------------------------------------------------------------------------- #
# Trailing empty assistant/tool_execute block excluded from history
# --------------------------------------------------------------------------- #


def test_trailing_empty_assistant_block_is_excluded() -> None:
    doc = parse_document("# %% user\nHi\n# %% assistant\n   \n", None)
    assert len(doc.messages) == 1
    assert doc.messages[0].role == "user"


def test_trailing_empty_tool_execute_block_is_excluded() -> None:
    doc = parse_document("# %% user\nHi\n# %% tool_execute\n\n", None)
    assert len(doc.messages) == 1
    assert doc.messages[0].role == "user"


def test_trailing_non_empty_assistant_block_is_kept() -> None:
    doc = parse_document("# %% user\nHi\n# %% assistant\nHello there\n", None)
    assert len(doc.messages) == 2
    assert doc.messages[-1].role == "assistant"


def test_trailing_empty_block_exclusion_is_case_insensitive_for_the_marker() -> None:
    # split_blocks normalises the block's type to lowercase regardless of source
    # casing, so this exclusion fires the same way for "# %% Assistant" as for
    # "# %% assistant" -- contrast this with has_empty_assistant_block in
    # blocks.py, which is deliberately case-sensitive for a different purpose
    # (deciding whether to start streaming).
    doc = parse_document("# %% user\nHi\n# %% Assistant\n   \n", None)
    assert len(doc.messages) == 1


def test_an_empty_trailing_user_block_is_not_specially_excluded_but_still_dropped() -> None:
    # There is no marker-level exclusion rule for "user" (only assistant/
    # tool_execute); an empty trailing user block is instead dropped by the
    # ordinary "parsed to nothing" path exercised below.
    doc = parse_document("# %% assistant\nHello\n# %% user\n\n", None)
    assert len(doc.messages) == 1
    assert doc.messages[0].role == "assistant"


# --------------------------------------------------------------------------- #
# System blocks: raw concatenation, joined and trimmed
# --------------------------------------------------------------------------- #


def test_system_blocks_are_concatenated_raw_and_joined_then_trimmed() -> None:
    text = "# %% system\n   Indented system line\n# %% system\n   Another line\n# %% user\nHi\n"
    doc = parse_document(text, None)
    # Internal formatting (the 3-space indent before "Another line") survives
    # because each block's RAW content is kept, not its stripped content; only
    # the ends of the final joined string are trimmed.
    assert doc.system_prompt == "Indented system line\n\n\n   Another line"


def test_a_single_system_block_is_used_verbatim_after_trimming() -> None:
    doc = parse_document("# %% system\n  Be terse.  \n# %% user\nHi\n", None)
    assert doc.system_prompt == "Be terse."


def test_empty_system_blocks_do_not_contribute_to_the_prompt() -> None:
    doc = parse_document("# %% system\n   \n# %% user\nHi\n", None)
    assert doc.system_prompt == ""


def test_no_system_block_at_all_gives_an_empty_prompt() -> None:
    doc = parse_document("# %% user\nHi\n", None)
    assert doc.system_prompt == ""


# --------------------------------------------------------------------------- #
# has_image_in_system_block
# --------------------------------------------------------------------------- #


def test_image_reference_in_a_system_block_sets_the_flag() -> None:
    doc = parse_document("# %% system\nSee [a diagram](diagram.png)\n# %% user\nHi\n", None)
    assert doc.has_image_in_system_block is True


def test_no_image_reference_leaves_the_flag_false() -> None:
    doc = parse_document("# %% system\nJust be helpful.\n# %% user\nHi\n", None)
    assert doc.has_image_in_system_block is False


def test_flag_stays_true_once_set_even_if_a_later_system_block_has_no_image() -> None:
    text = (
        "# %% system\nSee [a diagram](diagram.png)\n"
        "# %% system\nAlso be terse.\n"
        "# %% user\nHi\n"
    )
    doc = parse_document(text, None)
    assert doc.has_image_in_system_block is True


# --------------------------------------------------------------------------- #
# tool_execute blocks become role="user" messages
# --------------------------------------------------------------------------- #


def test_tool_execute_block_becomes_a_user_role_message() -> None:
    text = (
        "# %% user\nRun it\n"
        "# %% assistant\nOk.\n"
        "# %% tool_execute\n<tool_result>\ndone\n</tool_result>\n"
    )
    doc = parse_document(text, None)
    assert [m.role for m in doc.messages] == ["user", "assistant", "user"]
    assert doc.messages[-1].content == [TextContent(value="<tool_result>\ndone\n</tool_result>")]


def test_empty_tool_execute_block_in_the_middle_of_history_is_dropped() -> None:
    text = (
        "# %% user\nHi\n"
        "# %% tool_execute\n\n"  # empty, not the trailing block
        "# %% assistant\nHello\n"
    )
    doc = parse_document(text, None)
    assert [m.role for m in doc.messages] == ["user", "assistant"]


def test_tool_results_use_ids_when_parallel_sdk_calls_finish_out_of_order() -> None:
    text = "\n".join(
        [
            "# %% user",
            "Run both",
            "# %% assistant",
            render_tool_call("call-1", "files.first", {}),
            render_tool_call("call-2", "files.second", {}),
            "# %% tool_execute",
            render_server_tool_result(
                "call-2", "<tool_result>\nsecond result\n</tool_result>"
            ),
            "# %% tool_execute",
            render_server_tool_result(
                "call-1", "<tool_result>\nfirst result\n</tool_result>"
            ),
        ]
    )

    parsed = parse_document(text)
    results = [
        item
        for message in parsed.messages
        for item in message.content
        if isinstance(item, ToolResultContent)
    ]

    assert [(item.tool_use_id, item.name) for item in results] == [
        ("call-2", "files.second"),
        ("call-1", "files.first"),
    ]


# --------------------------------------------------------------------------- #
# User/assistant blocks that parse to nothing are dropped
# --------------------------------------------------------------------------- #


def test_empty_user_block_in_the_middle_of_history_is_dropped() -> None:
    text = "# %% assistant\nHello\n# %% user\n\n# %% assistant\nStill here\n"
    doc = parse_document(text, None)
    assert [m.role for m in doc.messages] == ["assistant", "assistant"]


def test_assistant_block_that_parses_to_only_whitespace_sections_is_dropped() -> None:
    # Non-empty raw content (it contains the "## %%" marker text itself, so the
    # early `if not content: continue` guard does not catch it), yet every
    # section inside is pure whitespace, so parse_assistant_content returns [].
    text = "# %% user\nHi\n# %% assistant\n## %% thinking\n   \n## %% text\n   \n# %% user\nBye\n"
    doc = parse_document(text, None)
    assert [m.role for m in doc.messages] == ["user", "user"]


def test_non_triggering_empty_assistant_block_in_the_middle_is_skipped() -> None:
    text = "# %% user\nHi\n# %% assistant\n\n# %% user\nStill talking\n"
    doc = parse_document(text, None)
    assert [m.role for m in doc.messages] == ["user", "user"]


# --------------------------------------------------------------------------- #
# Wait marker: attached when followed by tool_execute, not when followed by user
# --------------------------------------------------------------------------- #


def test_assistant_and_result_are_parsed_as_native_tool_history() -> None:
    text = (
        "# %% user\nDo something\n\n"
        f"# %% assistant\nLet me help.\n{_tool_call('foo')}\n\n"
        "# %% tool_execute\n<tool_result>\nok\n</tool_result>\n"
    )
    doc = parse_document(text, None)
    assistant_message = doc.messages[1]
    assert assistant_message.role == "assistant"
    assert assistant_message.content[0] == TextContent(value="Let me help.")
    tool_use = assistant_message.content[1]
    assert isinstance(tool_use, ToolUseContent)
    result = doc.messages[2].content[0]
    assert isinstance(result, ToolResultContent)
    assert result.tool_use_id == tool_use.id
    assert result.content == [TextContent(value="ok")]


def test_assistant_followed_by_user_does_not_get_the_wait_marker() -> None:
    """Without a completed tool_execute after it, the batch is still in flight (a
    resumed or partial assistant block), so claiming it ended with the marker
    would be a lie."""
    text = (
        "# %% user\nDo something\n\n"
        f"# %% assistant\nLet me help.\n{_tool_call('foo')}\n\n"
        "# %% user\nThanks\n"
    )
    doc = parse_document(text, None)
    assistant_message = doc.messages[1]
    assert assistant_message.content[0] == TextContent(value="Let me help.")
    assert isinstance(assistant_message.content[1], ToolUseContent)


def test_trailing_assistant_block_with_no_next_block_does_not_get_the_wait_marker() -> None:
    text = f"# %% user\nDo it\n# %% assistant\nOk.\n{_tool_call('foo')}\n"
    doc = parse_document(text, None)
    assistant_message = doc.messages[-1]
    content = assistant_message.content[0]
    assert isinstance(content, TextContent)
    assert CMD_WAIT_TOOL_RESULT_TAG not in content.value


# --------------------------------------------------------------------------- #
# Preamble: file_config, forbidden keys, junk before the first marker
# --------------------------------------------------------------------------- #


def test_preamble_is_parsed_into_file_config() -> None:
    text = "selectedConfig=work\n\n# %% user\nHi\n"
    doc = parse_document(text, None)
    assert doc.file_config == {"selectedConfig": "work"}
    assert doc.has_configuration_block is True


def test_blank_preamble_yields_an_empty_file_config() -> None:
    doc = parse_document("\n# %% user\nHi\n", None)
    assert doc.file_config == {}
    assert doc.has_configuration_block is False


def test_forbidden_preamble_key_raises() -> None:
    text = "apiKey=secret\n\n# %% user\nHi\n"
    with pytest.raises(ForbiddenInlineConfigKey):
        parse_document(text, None)


def test_junk_before_the_first_marker_raises() -> None:
    text = "this is junk, not key=value\n# %% user\nHi\n"
    with pytest.raises(InvalidStartContent):
        parse_document(text, None)


def test_document_with_no_markers_at_all_raises_on_the_prose() -> None:
    with pytest.raises(InvalidStartContent):
        parse_document("just some prose, no block markers here", None)


def test_document_that_is_entirely_blank_raises_nothing_and_has_no_messages() -> None:
    # No markers, but also nothing that looks like invalid prose: an
    # all-whitespace "preamble" is legal (blank lines are always allowed).
    doc = parse_document("   \n\n  ", None)
    assert doc.messages == []


# --------------------------------------------------------------------------- #
# "# %% settings" lands in .settings and nowhere else
# --------------------------------------------------------------------------- #


def test_settings_block_is_parsed_into_the_settings_field() -> None:
    text = '# %% settings\n[section]\nkey = "value"\n\n# %% user\nHi\n# %% assistant\nHello\n'
    doc = parse_document(text, None)
    assert doc.settings == {"section": {"key": "value"}}


def test_settings_block_does_not_produce_a_message_or_touch_the_system_prompt() -> None:
    text = '# %% settings\n[section]\nkey = "value"\n\n# %% user\nHi\n# %% assistant\nHello\n'
    doc = parse_document(text, None)
    assert [m.role for m in doc.messages] == ["user", "assistant"]
    assert doc.system_prompt == ""


def test_no_settings_block_leaves_settings_as_none() -> None:
    doc = parse_document("# %% user\nHi\n", None)
    assert doc.settings is None


def test_settings_block_with_unrecognised_syntax_yields_an_empty_dict_not_an_error() -> None:
    # parse_settings_block never raises on malformed input (a deliberately
    # best-effort, tolerant format): a line matching none of its grammar is just
    # silently skipped, so this still comes back as {} rather than propagating
    # any kind of parse failure up through parse_document.
    text = "# %% settings\nnonsense that matches no settings grammar at all\n\n# %% user\nHi\n"
    doc = parse_document(text, None)
    assert doc.settings == {}


# --------------------------------------------------------------------------- #
# Golden tests: every real .chat.md file committed to the repo
# --------------------------------------------------------------------------- #
#
# These samples predate the "<cmd:tool_call>" syntax (they use a fenced
# "<tool_call>" block instead), so no tool call in them is ever recognised by
# chatmd.tools.call_parser -- that is expected, not a gap in these tests.


def _all_content_is_non_empty(content: list[object]) -> bool:
    for item in content:
        if isinstance(item, TextContent) and not item.value.strip():
            return False
        if isinstance(item, ImageContent) and not item.path.strip():
            return False
    return True


@pytest.mark.parametrize(
    "sample_name",
    ["image-tool-demo.chat.md", "vite-todo-app-react.chat.md", "vite-todoapp-claude.chat.md"],
)
def test_every_sample_parses_without_raising_and_has_well_formed_messages(
    samples_dir: Path, sample_name: str
) -> None:
    text = (samples_dir / sample_name).read_text(encoding="utf-8")

    doc = parse_document(text, samples_dir)

    assert len(doc.messages) > 0
    for message in doc.messages:
        assert message.role in ("user", "assistant")
        assert len(message.content) > 0
        assert _all_content_is_non_empty(message.content)


@pytest.mark.parametrize(
    "sample_name",
    ["image-tool-demo.chat.md", "vite-todo-app-react.chat.md", "vite-todoapp-claude.chat.md"],
)
def test_every_sample_has_no_system_prompt_or_settings(samples_dir: Path, sample_name: str) -> None:
    # None of the committed samples use "# %% system" or "# %% settings" at all.
    text = (samples_dir / sample_name).read_text(encoding="utf-8")
    doc = parse_document(text, samples_dir)
    assert doc.system_prompt == ""
    assert doc.has_image_in_system_block is False
    assert doc.settings is None
    assert doc.file_config == {}
    assert doc.has_configuration_block is False


def test_sample_with_a_trailing_empty_assistant_block_excludes_it_from_history(
    samples_dir: Path,
) -> None:
    text = (samples_dir / "vite-todo-app-react.chat.md").read_text(encoding="utf-8")
    assert text.rstrip().endswith("# %% assistant")  # sanity: it really is trailing+empty

    doc = parse_document(text, samples_dir)

    # The trailing marker was the streaming trigger, not conversation: the last
    # real message must come from the block before it (a tool_execute -> user).
    assert doc.messages[-1].role == "user"


def test_sample_with_image_links_resolves_them_to_image_content(samples_dir: Path) -> None:
    text = (samples_dir / "vite-todoapp-claude.chat.md").read_text(encoding="utf-8")
    doc = parse_document(text, samples_dir)

    image_paths = {
        item.path
        for message in doc.messages
        for item in message.content
        if isinstance(item, ImageContent)
    }
    assert "image-18.png" in image_paths
    assert "image-20.png" in image_paths


def test_sample_tool_execute_link_to_a_nonexistent_asset_passes_through_without_raising(
    samples_dir: Path,
) -> None:
    # vite-todo-app-react.chat.md's tool_execute blocks link to
    # "cmdassets/tool-result-...txt" files that were never committed to the repo;
    # this must degrade to a plain passthrough (see test_parser_tool_result.py),
    # not raise.
    text = (samples_dir / "vite-todo-app-react.chat.md").read_text(encoding="utf-8")
    doc = parse_document(text, samples_dir)
    assert any(m.role == "user" for m in doc.messages)
