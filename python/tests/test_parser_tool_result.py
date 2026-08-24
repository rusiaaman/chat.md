"""Tests for chatmd.parser.tool_result: turning a ``# %% tool_execute`` block back
into message content.

Port of ``processToolResultContent`` in TS ``src/parser.ts``. Tool results are
replayed to the model as user messages; this module inlines a result that was
written to a file because it was too long, and turns an image markdown link a
tool produced into real image content.
"""

from __future__ import annotations

from pathlib import Path

from chatmd.parser.tool_result import process_tool_result_content
from chatmd.types import ImageContent, TextContent

# --------------------------------------------------------------------------- #
# base_dir=None / no <tool_result> wrapper: pass through unchanged
# --------------------------------------------------------------------------- #


def test_no_base_dir_returns_the_raw_content_unchanged() -> None:
    content = "<tool_result>\n[x](y.txt)\n</tool_result>"
    assert process_tool_result_content(content, base_dir=None) == [TextContent(value=content)]


def test_content_without_a_tool_result_wrapper_passes_through(tmp_path: Path) -> None:
    content = "just some plain text with no wrapper at all"
    assert process_tool_result_content(content, tmp_path) == [TextContent(value=content)]


# --------------------------------------------------------------------------- #
# Embedded image links split into interleaved text/image content
# --------------------------------------------------------------------------- #


def test_embedded_image_link_becomes_interleaved_image_content(tmp_path: Path) -> None:
    content = (
        "<tool_result>\n"
        "Here's the chart you asked for:\n\n"
        "![chart](chart.png)\n\n"
        "It shows an upward trend.\n"
        "</tool_result>"
    )
    result = process_tool_result_content(content, tmp_path)
    assert result == [
        TextContent(value="Here's the chart you asked for:"),
        ImageContent(path="chart.png"),
        TextContent(value="It shows an upward trend."),
    ]


def test_multiple_embedded_images_are_all_extracted(tmp_path: Path) -> None:
    content = "<tool_result>\n![a](a.png)\nbetween\n![b](b.jpg)\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [
        ImageContent(path="a.png"),
        TextContent(value="between"),
        ImageContent(path="b.jpg"),
    ]


def test_image_link_extraction_does_not_check_file_existence(tmp_path: Path) -> None:
    # Unlike the single-link text/image substitution path below, an inline image
    # markdown link inside a tool result is split out unconditionally -- there is
    # no fileExists gate here, since the tool is asserting the image exists.
    content = "<tool_result>\n![missing](does-not-exist.png)\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [ImageContent(path="does-not-exist.png")]


# --------------------------------------------------------------------------- #
# A body that is exactly one markdown link to an existing text file: substituted
# back into the wrapper.
# --------------------------------------------------------------------------- #


def test_single_link_to_an_existing_text_file_is_substituted_into_the_wrapper(
    tmp_path: Path,
) -> None:
    (tmp_path / "result.txt").write_text("actual file content", encoding="utf-8")
    content = "<tool_result>\n[Tool Result](result.txt)\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [TextContent(value="<tool_result>\nactual file content\n</tool_result>")]


def test_substitution_preserves_text_surrounding_the_wrapper(tmp_path: Path) -> None:
    (tmp_path / "result.txt").write_text("actual file content", encoding="utf-8")
    content = (
        "Preamble text\n<tool_result>\n[Tool Result](result.txt)\n</tool_result>\nTrailing text"
    )
    result = process_tool_result_content(content, tmp_path)
    assert result == [
        TextContent(
            value=(
                "Preamble text\n<tool_result>\nactual file content\n</tool_result>\n"
                "Trailing text"
            )
        )
    ]


def test_link_to_an_existing_but_empty_file_passes_through_unchanged(tmp_path: Path) -> None:
    (tmp_path / "empty.txt").write_text("", encoding="utf-8")
    content = "<tool_result>\n[Tool Result](empty.txt)\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [TextContent(value=content)]


# --------------------------------------------------------------------------- #
# The same, for an image link: becomes image content directly (no wrapper).
# --------------------------------------------------------------------------- #


def test_single_link_to_an_existing_image_file_becomes_image_content(tmp_path: Path) -> None:
    (tmp_path / "chart.png").write_bytes(b"")
    content = "<tool_result>\n[Tool Result](chart.png)\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [ImageContent(path="chart.png")]


def test_single_image_link_keeps_the_original_unresolved_target(tmp_path: Path) -> None:
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "chart.png").write_bytes(b"")
    content = "<tool_result>\n[Tool Result](sub/chart.png)\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [ImageContent(path="sub/chart.png")]


# --------------------------------------------------------------------------- #
# A link to a nonexistent file passes through unchanged.
# --------------------------------------------------------------------------- #


def test_single_link_to_a_nonexistent_file_passes_through_unchanged(tmp_path: Path) -> None:
    content = "<tool_result>\n[Tool Result](does-not-exist.txt)\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [TextContent(value=content)]


def test_body_that_is_not_a_single_link_passes_through_unchanged(tmp_path: Path) -> None:
    content = "<tool_result>\nSome text and a [link](x.txt) but more text after\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    assert result == [TextContent(value=content)]


# --------------------------------------------------------------------------- #
# Whole-body code fence stripped before the link test; a fence in the middle is
# left alone.
# --------------------------------------------------------------------------- #


def test_whole_body_code_fence_is_stripped_before_the_link_test(tmp_path: Path) -> None:
    (tmp_path / "result.txt").write_text("actual file content", encoding="utf-8")
    content = "<tool_result>\n```\n[Tool Result](result.txt)\n```\n</tool_result>"
    result = process_tool_result_content(content, tmp_path)
    # The fence is gone entirely: the link inside it was still recognised and
    # substituted, and the fence markers do not survive into the replacement.
    assert result == [TextContent(value="<tool_result>\nactual file content\n</tool_result>")]


def test_a_fence_in_the_middle_of_the_body_is_not_stripped(tmp_path: Path) -> None:
    # The whole-fence regex only strips a fence that spans the ENTIRE body; a
    # fence that is merely part of a larger body is left untouched, and (since
    # what remains is not a single markdown link) the whole thing passes through.
    (tmp_path / "result.txt").write_text("actual file content", encoding="utf-8")
    content = (
        "<tool_result>\n"
        "Some text\n```\ncode here\n```\nMore text\n"
        "</tool_result>"
    )
    result = process_tool_result_content(content, tmp_path)
    assert result == [TextContent(value=content)]
