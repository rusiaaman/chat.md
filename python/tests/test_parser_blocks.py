"""Tests for chatmd.parser.blocks: splitting a document into ``# %%`` role blocks.

Port of the block-marker splitting/detection logic in TS ``src/parser.ts`` (the
``parseDocument`` split regex, ``hasEmptyAssistantBlock``/``hasEmptyToolExecuteBlock``,
``findAllAssistantBlocks``) plus ``countToolExecuteBlocks`` from ``src/listener.ts``.
"""

from __future__ import annotations

from chatmd.parser.blocks import (
    AssistantBlockPos,
    Block,
    count_tool_execute_blocks,
    find_all_assistant_blocks,
    has_empty_assistant_block,
    has_empty_tool_execute_block,
    split_blocks,
)

# --------------------------------------------------------------------------- #
# split_blocks
# --------------------------------------------------------------------------- #


def test_split_blocks_on_a_simple_document() -> None:
    text = "# %% user\nHi\n# %% assistant\nHello\n"
    blocks = split_blocks(text)
    assert [b.type for b in blocks] == ["user", "assistant"]
    assert blocks[0].raw_content == "\nHi\n"
    assert blocks[1].raw_content == "\nHello\n"


def test_split_blocks_markers_are_matched_case_insensitively() -> None:
    # Any case spelling of a role still splits into a real block, in contrast to
    # has_empty_assistant_block below which is deliberately case-sensitive.
    text = "# %% USER\nHi\n# %% Assistant\nHello\n"
    blocks = split_blocks(text)
    assert [b.type for b in blocks] == ["user", "assistant"]


def test_split_blocks_type_is_normalized_to_lowercase() -> None:
    blocks = split_blocks("# %% TOOL_EXECUTE\nfoo\n")
    assert blocks[0].type == "tool_execute"


def test_split_blocks_no_markers_returns_empty_list() -> None:
    assert split_blocks("just some prose, no markers here") == []


def test_split_blocks_excludes_the_leading_preamble() -> None:
    # The text before the first marker (the configuration preamble) is not one of
    # the returned blocks; callers slice it themselves via marker_start.
    text = "selectedConfig=foo\n\n# %% user\nHi\n"
    blocks = split_blocks(text)
    assert len(blocks) == 1
    assert text[: blocks[0].marker_start] == "selectedConfig=foo\n\n"


def test_split_blocks_offsets_and_raw_content_are_consistent() -> None:
    text = "# %% user\nHi there\n# %% assistant\nHello back\n"
    blocks = split_blocks(text)
    for block in blocks:
        assert text[block.marker_start : block.content_start].startswith("# %% ")
        # raw_content is exactly the slice between content_start and the next
        # marker (or end of text).
    assert text[blocks[0].content_start :].startswith(blocks[0].raw_content)


def test_split_blocks_last_block_content_runs_to_end_of_text() -> None:
    text = "# %% user\nHi\n# %% assistant\nHello, no trailing newline"
    blocks = split_blocks(text)
    assert blocks[-1].raw_content == "\nHello, no trailing newline"


def test_split_blocks_equality_of_block_dataclass() -> None:
    blocks = split_blocks("# %% user\nHi\n")
    assert blocks == [Block(type="user", raw_content="\nHi\n", marker_start=0, content_start=9)]


# --------------------------------------------------------------------------- #
# has_empty_assistant_block / has_empty_tool_execute_block
# --------------------------------------------------------------------------- #


def test_has_empty_assistant_block_true_when_only_whitespace_follows_marker() -> None:
    assert has_empty_assistant_block("# %% user\nHi\n# %% assistant\n   \n") is True


def test_has_empty_assistant_block_true_with_no_newline_after_marker() -> None:
    assert has_empty_assistant_block("# %% assistant") is True


def test_has_empty_assistant_block_false_when_content_present() -> None:
    assert has_empty_assistant_block("# %% assistant\nHello") is False


def test_has_empty_assistant_block_false_when_marker_absent() -> None:
    assert has_empty_assistant_block("# %% user\nHi\n") is False


def test_has_empty_assistant_block_uses_the_last_occurrence() -> None:
    # An earlier empty-looking assistant marker must not trigger this: only the
    # LAST "# %% assistant" in the document decides whether the document ends
    # with an empty one (mirrors TS's lastIndexOf).
    text = "# %% assistant\nold content\n# %% user\nHi\n# %% assistant\n"
    assert has_empty_assistant_block(text) is True
    assert has_empty_assistant_block("# %% assistant\n\n# %% user\nHi\n") is False


def test_has_empty_assistant_block_is_case_sensitive_unlike_split_blocks() -> None:
    """A real inherited inconsistency from the TS source: split_blocks treats
    "# %% Assistant" as a genuine assistant block (case-insensitive), but the
    streaming trigger below only ever recognises the exact lowercase spelling.
    A document ending in a mixed-case empty assistant block is therefore a real,
    empty assistant block to the parser, yet invisible to the streamer trigger."""
    text = "# %% user\nHi\n# %% Assistant\n   \n"
    assert split_blocks(text)[-1].type == "assistant"
    assert split_blocks(text)[-1].raw_content.strip() == ""
    assert has_empty_assistant_block(text) is False


def test_has_empty_tool_execute_block_true_and_false() -> None:
    assert has_empty_tool_execute_block("# %% tool_execute\n\n") is True
    assert has_empty_tool_execute_block("# %% tool_execute\n<tool_result>x</tool_result>") is False
    assert has_empty_tool_execute_block("# %% Tool_Execute\n\n") is False  # case-sensitive too


# --------------------------------------------------------------------------- #
# find_all_assistant_blocks
# --------------------------------------------------------------------------- #


def test_find_all_assistant_blocks_finds_every_marker() -> None:
    text = "preamble\n# %% assistant  \nHello\n# %% assistant\n\nWorld"
    positions = find_all_assistant_blocks(text)
    assert len(positions) == 2
    assert positions[0] == AssistantBlockPos(marker_start=9, content_start=26)
    assert positions[1] == AssistantBlockPos(marker_start=32, content_start=47)
    assert text[positions[0].content_start :].startswith("Hello")


def test_find_all_assistant_blocks_content_start_skips_only_a_single_newline() -> None:
    """content_start walks past spaces/tabs then exactly ONE newline: a blank line
    left between the marker and the real content is not further consumed, which
    matters because the streamer's idempotent-append search depends on this exact
    offset lining up with where tokens get inserted."""
    text = "# %% assistant\n\nWorld"
    positions = find_all_assistant_blocks(text)
    assert len(positions) == 1
    # Only the first "\n" (the one ending the marker line) is skipped; the blank
    # line's own newline survives as the start of the content.
    assert text[positions[0].content_start :] == "\nWorld"


def test_find_all_assistant_blocks_content_start_at_end_of_text_when_marker_is_last_line() -> None:
    text = "# %% user\nHi\n# %% assistant"
    positions = find_all_assistant_blocks(text)
    assert positions[-1].content_start == len(text)


def test_find_all_assistant_blocks_no_markers_returns_empty_list() -> None:
    assert find_all_assistant_blocks("no markers here at all") == []


def test_find_all_assistant_blocks_ignores_other_block_types() -> None:
    text = "# %% user\nHi\n# %% assistant\nHello\n"
    assert len(find_all_assistant_blocks(text)) == 1


# --------------------------------------------------------------------------- #
# count_tool_execute_blocks
# --------------------------------------------------------------------------- #


def test_count_tool_execute_blocks_counts_lowercase_markers() -> None:
    text = "# %% tool_execute\nfoo\n# %% tool_execute\nbar\n"
    assert count_tool_execute_blocks(text) == 2


def test_count_tool_execute_blocks_ignores_other_case_spellings() -> None:
    """listener.ts's countToolExecuteBlocks only counts the lowercase spelling, so
    a document that writes "# %% Tool_Execute" splits into a real block via
    split_blocks (case-insensitive) but is invisible to this counter."""
    text = "# %% tool_execute\nfoo\n# %% Tool_Execute\nbar\n# %% TOOL_EXECUTE\nbaz\n"
    assert count_tool_execute_blocks(text) == 1
    assert [b.type for b in split_blocks(text)] == ["tool_execute", "tool_execute", "tool_execute"]


def test_count_tool_execute_blocks_zero_when_absent() -> None:
    assert count_tool_execute_blocks("# %% user\nHi\n") == 0
