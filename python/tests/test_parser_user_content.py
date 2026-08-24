"""Tests for chatmd.parser.user_content: resolving file/image references inside a
``# %% user`` block.

Port of ``parseUserContent`` and ``containsImageReference`` in TS ``src/parser.ts``.
"""

from __future__ import annotations

from pathlib import Path

from chatmd.parser.user_content import contains_image_reference, parse_user_content
from chatmd.types import ImageContent, TextContent

# --------------------------------------------------------------------------- #
# base_dir=None: nothing to resolve against
# --------------------------------------------------------------------------- #


def test_no_base_dir_returns_the_raw_text_as_one_block() -> None:
    # Some callers invoke this with no document context at all; the text must
    # survive completely unchanged rather than attempting (and failing) to
    # resolve references against nothing.
    text = "Hi, please look at [#file](notes.txt) for me."
    assert parse_user_content(text, base_dir=None) == [TextContent(value=text)]


def test_no_base_dir_is_the_default_argument() -> None:
    assert parse_user_content("just text") == [TextContent(value="just text")]


# --------------------------------------------------------------------------- #
# [#file] and extension-heuristic links
# --------------------------------------------------------------------------- #


def test_hash_file_link_resolves_a_text_file(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("file body", encoding="utf-8")
    content = parse_user_content("[#file](notes.txt)", tmp_path)
    assert content == [TextContent(value="Attached file: notes.txt\n```\nfile body\n```")]


def test_extension_heuristic_link_resolves_without_hash_file_text(tmp_path: Path) -> None:
    # The link text need not be "#file": a path that merely looks file-shaped
    # (has an extension) is enough to be treated as a reference.
    (tmp_path / "readme.md").write_text("readme body", encoding="utf-8")
    content = parse_user_content("please read [readme](readme.md) now", tmp_path)
    assert content == [
        TextContent(value="please read"),
        TextContent(value="Attached file: readme.md\n```\nreadme body\n```"),
        TextContent(value="now"),
    ]


def test_link_without_hash_file_text_and_without_an_extension_is_not_a_reference() -> None:
    # Neither "#file" link text nor an extension-shaped path: this is an ordinary
    # markdown link, left as plain text.
    text = "see [my article](https://example.com/blog) for details"
    assert parse_user_content(text, Path("/nonexistent")) == [TextContent(value=text)]


# --------------------------------------------------------------------------- #
# MCP prompt links
# --------------------------------------------------------------------------- #


def test_mcp_prompt_link_inlines_raw_content_with_no_wrapper(tmp_path: Path) -> None:
    (tmp_path / "prompt.txt").write_text("Prompt body text", encoding="utf-8")
    content = parse_user_content("[MCP Prompt: my_prompt](prompt.txt)", tmp_path)
    # No "Attached file:" wrapper, unlike an ordinary text-file reference.
    assert content == [TextContent(value="Prompt body text")]


def test_mcp_prompt_link_to_a_missing_file_reports_file_not_found(tmp_path: Path) -> None:
    content = parse_user_content("[MCP Prompt: my_prompt](missing.txt)", tmp_path)
    assert content == [TextContent(value="[File not found: missing.txt]")]


# --------------------------------------------------------------------------- #
# "Attached file at" syntax, with and without a following fenced block
# --------------------------------------------------------------------------- #


def test_attached_file_at_with_following_fence_swallows_the_fence(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("actual disk content", encoding="utf-8")
    text = "Attached file at notes.txt\n```\nignored content pasted by the user\n```\nMore text"
    content = parse_user_content(text, tmp_path)
    # The fenced block in the DOCUMENT is consumed by the match entirely; what
    # ends up in the output is the file's real on-disk content, not the fence.
    assert content == [
        TextContent(value="Attached file: notes.txt\n```\nactual disk content\n```"),
        TextContent(value="\nMore text"),
    ]


def test_attached_file_at_without_a_following_fence(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("actual disk content", encoding="utf-8")
    text = "Attached file at notes.txt\nMore text"
    content = parse_user_content(text, tmp_path)
    assert content == [
        TextContent(value="Attached file: notes.txt\n```\nactual disk content\n```"),
        TextContent(value="\nMore text"),
    ]


# --------------------------------------------------------------------------- #
# Images keep their original, unresolved path
# --------------------------------------------------------------------------- #


def test_image_reference_keeps_the_original_unresolved_path(tmp_path: Path) -> None:
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "pic.png").write_bytes(b"")
    content = parse_user_content("[#file](sub/pic.png)", tmp_path)
    # Not the resolved absolute path -- the document is the portable record, so
    # it must keep pointing at what the author actually wrote.
    assert content == [ImageContent(path="sub/pic.png")]


def test_attached_image_file_keeps_the_original_path(tmp_path: Path) -> None:
    (tmp_path / "pic.png").write_bytes(b"")
    content = parse_user_content("Attached file at pic.png", tmp_path)
    assert content == [ImageContent(path="pic.png")]


# --------------------------------------------------------------------------- #
# Text files are wrapped
# --------------------------------------------------------------------------- #


def test_text_file_is_wrapped_in_the_attached_file_format(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("print('hi')", encoding="utf-8")
    content = parse_user_content("[#file](a.py)", tmp_path)
    assert content == [TextContent(value="Attached file: a.py\n```\nprint('hi')\n```")]


# --------------------------------------------------------------------------- #
# Missing files
# --------------------------------------------------------------------------- #


def test_missing_file_becomes_a_file_not_found_placeholder(tmp_path: Path) -> None:
    content = parse_user_content("[#file](missing.txt)", tmp_path)
    assert content == [TextContent(value="[File not found: missing.txt]")]


def test_missing_attached_file_becomes_a_file_not_found_placeholder(tmp_path: Path) -> None:
    content = parse_user_content("Attached file at missing.txt", tmp_path)
    assert content == [TextContent(value="[File not found: missing.txt]")]


# --------------------------------------------------------------------------- #
# Document order and interleaving
# --------------------------------------------------------------------------- #


def test_multiple_refs_are_processed_in_document_order_interleaved_with_text(
    tmp_path: Path,
) -> None:
    (tmp_path / "a.txt").write_text("A body", encoding="utf-8")
    (tmp_path / "b.txt").write_text("B body", encoding="utf-8")
    text = "Start. [#file](a.txt) Middle. [#file](b.txt) End."
    content = parse_user_content(text, tmp_path)
    assert content == [
        TextContent(value="Start."),
        TextContent(value="Attached file: a.txt\n```\nA body\n```"),
        TextContent(value="Middle."),
        TextContent(value="Attached file: b.txt\n```\nB body\n```"),
        TextContent(value="End."),
    ]


def test_attached_and_markdown_refs_interleave_by_position_not_by_kind(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_text("A body", encoding="utf-8")
    (tmp_path / "b.txt").write_text("B body", encoding="utf-8")
    # The markdown-style ref appears later in the text than the "Attached file at"
    # ref, even though markdown refs are collected as a separate regex pass.
    text = "Attached file at a.txt\nThen [#file](b.txt) too."
    content = parse_user_content(text, tmp_path)
    assert content == [
        TextContent(value="Attached file: a.txt\n```\nA body\n```"),
        TextContent(value="\nThen"),
        TextContent(value="Attached file: b.txt\n```\nB body\n```"),
        TextContent(value="too."),
    ]


# --------------------------------------------------------------------------- #
# The markdown link regex eats surrounding whitespace
# --------------------------------------------------------------------------- #


def test_markdown_link_regex_eats_surrounding_whitespace(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("hi", encoding="utf-8")
    text = "Before   [#file](notes.txt)   After"
    content = parse_user_content(text, tmp_path)
    # The spaces immediately around the link are consumed as part of the match,
    # so they show up in neither surviving text segment.
    assert content == [
        TextContent(value="Before"),
        TextContent(value="Attached file: notes.txt\n```\nhi\n```"),
        TextContent(value="After"),
    ]


def test_markdown_link_regex_eats_surrounding_blank_lines(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("hi", encoding="utf-8")
    text = "Hello world.\n\n[#file](notes.txt)\n\nGoodbye."
    content = parse_user_content(text, tmp_path)
    assert content == [
        TextContent(value="Hello world."),
        TextContent(value="Attached file: notes.txt\n```\nhi\n```"),
        TextContent(value="Goodbye."),
    ]


# --------------------------------------------------------------------------- #
# Whitespace-only leftovers are dropped, not emitted as empty text blocks
# --------------------------------------------------------------------------- #


def test_pure_whitespace_around_a_ref_produces_no_extra_text_blocks(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("hi", encoding="utf-8")
    content = parse_user_content("   [#file](notes.txt)   ", tmp_path)
    assert content == [TextContent(value="Attached file: notes.txt\n```\nhi\n```")]


def test_no_refs_at_all_returns_the_whole_text_as_one_block(tmp_path: Path) -> None:
    content = parse_user_content("just plain conversation, no files here", tmp_path)
    assert content == [TextContent(value="just plain conversation, no files here")]


# --------------------------------------------------------------------------- #
# contains_image_reference
# --------------------------------------------------------------------------- #


def test_contains_image_reference_true_for_markdown_image_link() -> None:
    assert contains_image_reference("[a diagram](diagram.png)") is True


def test_contains_image_reference_true_for_bmp_which_is_image_file_does_not_recognise() -> None:
    # Deliberately looser than fileio.is_image_file (no .bmp support there): this
    # guard is only used to flag system blocks, so erring toward "yes" is safe.
    assert contains_image_reference("[a scan](scan.bmp)") is True


def test_contains_image_reference_true_for_attached_file_at_image() -> None:
    assert contains_image_reference("Attached file at /tmp/photo.JPG") is True


def test_contains_image_reference_false_for_non_image_extension() -> None:
    assert contains_image_reference("[a report](report.pdf)") is False


def test_contains_image_reference_false_for_plain_text() -> None:
    assert contains_image_reference("just some ordinary system prompt text") is False
