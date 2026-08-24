"""Splitting a ``.chat.md`` document into its ``# %%`` role blocks.

Port of the block-marker parts of ``src/parser.ts`` (the regex used inside
``parseDocument``) and of ``hasEmptyAssistantBlock`` / ``hasEmptyToolExecuteBlock`` /
``findAllAssistantBlocks`` from the same file, plus ``countToolExecuteBlocks`` from
``src/listener.ts`` (it belongs conceptually with the other block-counting helpers
even though the TS original keeps it in the listener).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import cast

from chatmd.types import BlockType

#: One marker line, e.g. ``# %% assistant``. MULTILINE so ``^``/``$`` bind to each
#: line; IGNORECASE because the TS split regex carries the ``i`` flag -- a document
#: may spell a role in any case and still split correctly (contrast this with
#: ``has_empty_assistant_block`` below, which is deliberately case-sensitive).
BLOCK_MARKER_RE: re.Pattern[str] = re.compile(
    r"^# %% (user|assistant|system|tool_execute|settings)\s*$",
    re.MULTILINE | re.IGNORECASE,
)

# No IGNORECASE: mirrors listener.ts's countToolExecuteBlocks, which only counts the
# lowercase spelling. A document that writes "# %% Tool_Execute" splits into a block
# by BLOCK_MARKER_RE just fine but is invisible to this counter.
_TOOL_EXECUTE_MARKER_RE = re.compile(r"^# %% tool_execute[ \t]*$", re.MULTILINE)

_ASSISTANT_LINE_RE = re.compile(r"^# %% assistant\s*$", re.IGNORECASE)

_WHITESPACE_ONLY_RE = re.compile(r"\A\s*\Z")


@dataclass(frozen=True)
class Block:
    """One ``# %%`` role block: its type and its raw (untrimmed) content."""

    type: BlockType
    #: Content with original whitespace, i.e. exactly what a JS
    #: ``text.split(BLOCK_MARKER_RE)`` capture-group split would have produced.
    raw_content: str
    marker_start: int
    content_start: int


@dataclass(frozen=True)
class AssistantBlockPos:
    marker_start: int
    content_start: int


def split_blocks(text: str) -> list[Block]:
    """Split ``text`` on ``# %%`` markers into role blocks.

    Mirrors JS ``text.split(BLOCK_MARKER_RE)``, minus the leading preamble slice
    (the piece before the first marker): callers that need it can take
    ``text[:blocks[0].marker_start]`` themselves, or the whole text when this
    returns ``[]``.
    """
    matches = list(BLOCK_MARKER_RE.finditer(text))
    blocks: list[Block] = []
    for index, match in enumerate(matches):
        content_start = match.end()
        next_marker_start = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        blocks.append(
            Block(
                type=cast("BlockType", match.group(1).lower()),
                raw_content=text[content_start:next_marker_start],
                marker_start=match.start(),
                content_start=content_start,
            )
        )
    return blocks


def _has_empty_block_of_type(text: str, block_type: str) -> bool:
    """Shared body of ``has_empty_assistant_block``/``has_empty_tool_execute_block``.

    Deliberately a plain, case-sensitive substring search (``str.rfind``, not the
    case-insensitive ``BLOCK_MARKER_RE``): this is a direct port of the TS
    ``hasEmptyBlockOfType``, which uses ``text.lastIndexOf(marker)`` on the exact
    lowercase marker text. A block spelled ``# %% Assistant`` is a real block to
    the parser above but invisible to the streaming/tool trigger below -- that
    inconsistency is inherited from the TS source, not introduced here.
    """
    marker = f"# %% {block_type}"
    last_marker_index = text.rfind(marker)
    if last_marker_index == -1:
        return False

    newline_after_marker = text.find("\n", last_marker_index)
    content_start_index = (
        last_marker_index + len(marker) if newline_after_marker == -1 else newline_after_marker + 1
    )
    content_after_marker = text[content_start_index:]
    return _WHITESPACE_ONLY_RE.match(content_after_marker) is not None


def has_empty_assistant_block(text: str) -> bool:
    """True when the document ends with an empty ``# %% assistant`` block.

    Used to decide when to start streaming.
    """
    return _has_empty_block_of_type(text, "assistant")


def has_empty_tool_execute_block(text: str) -> bool:
    """True when the document ends with an empty ``# %% tool_execute`` block.

    Used to decide when to run a tool.
    """
    return _has_empty_block_of_type(text, "tool_execute")


def find_all_assistant_blocks(text: str) -> list[AssistantBlockPos]:
    """Locate every ``# %% assistant`` marker, with the offset where its content
    (the text a streamer appends to) begins.

    ``content_start`` walks past spaces/tabs then a single newline after the
    marker line, exactly like the TS version -- the streamer's idempotent-append
    search depends on this offset lining up with where tokens actually get
    inserted.
    """
    blocks: list[AssistantBlockPos] = []
    lines = text.split("\n")
    line_offset = 0

    for line in lines:
        if _ASSISTANT_LINE_RE.match(line):
            marker_start = line_offset
            content_start = line_offset + len(line)

            while content_start < len(text) and text[content_start] in (" ", "\t"):
                content_start += 1
            if content_start < len(text) and text[content_start] == "\n":
                content_start += 1

            blocks.append(AssistantBlockPos(marker_start=marker_start, content_start=content_start))

        line_offset += len(line) + 1  # +1 for the newline consumed by str.split

    return blocks


def count_tool_execute_blocks(text: str) -> int:
    """Count ``# %% tool_execute`` marker lines.

    Used to figure out how many tool calls of an assistant block have already run.
    """
    return len(_TOOL_EXECUTE_MARKER_RE.findall(text))
