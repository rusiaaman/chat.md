"""Pure helpers for the "## %% thinking" / "## %% text" sub-blocks of an assistant
turn, and for rendering a batch of stream events into the text appended to one.

Port of ``src/utils/thinkingBlocks.ts``, plus ``blockMarkerPrefix`` from
``src/parser.ts``. The TypeScript version smuggles non-text stream tokens through
NUL-prefixed strings (``THINKING_TOKEN_PREFIX``, ``THINKING_PAYLOAD_PREFIX`` and the
encode/decode/is-token helpers) because its streamer only has a flat token list to
work with. Python's streamer instead produces proper ``StreamEvent`` objects
(``TextDelta`` / ``ThinkingDelta`` / ``ThinkingPayloadDelta`` / ``UsageDelta``), so
none of that smuggling is needed here — the union is discriminated by ``isinstance``
directly.

This module has no dependency on the rest of the engine beyond ``chatmd.types``, so
it can be unit tested in isolation.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

from chatmd.markers import escape_markers
from chatmd.types import (
    StreamEvent,
    TextDelta,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    UsageDelta,
)

# Marker that opens a thinking section inside an assistant block.
THINKING_SECTION_MARKER = "## %% thinking"

# Marker that opens a normal text section inside an assistant block.
TEXT_SECTION_MARKER = "## %% text"

# The TS source keeps two identically-sourced regexes (one for the split, one for
# the presence test) because JS regex objects with the `g` flag carry mutable
# `lastIndex` state; neither of these has that flag, so a single compiled pattern
# is safe to reuse for both purposes here.
_SECTION_MARKER_RE = re.compile(r"^## %% (thinking|text)[ \t]*$", re.MULTILINE | re.IGNORECASE)

# Greedy model part so the split happens on the last "::" of the line.
_SIGNATURE_LINE_RE = re.compile(r"^(.+)::([0-9a-f]{8})$")


@dataclass(frozen=True)
class AssistantSection:
    type: Literal["thinking", "text"]
    content: str


@dataclass(frozen=True)
class ParsedThinkingSection:
    """Thinking text without the trailing signature line, plus the parsed signature."""

    text: str
    #: Qualified model name from the signature line.
    model: str | None = None
    #: 8 character hash from the signature line.
    hash: str | None = None


@dataclass
class SectionState:
    """Which section of the assistant block the streamer is currently writing into."""

    thinking_open: bool = False
    text_open: bool = False
    saw_thinking: bool = False
    #: Offset in the assistant block where the current text section content starts.
    scan_offset: int = 0
    #: Offset in the assistant block where the current text section content ends,
    #: or None while the text section is still open (it extends to the end).
    #:
    #: Set when a thinking section opens, which closes the text section before it.
    #: Together with scan_offset this bounds the region that may be scanned for
    #: tool calls to assistant text only, so ``<cmd:...>`` written inside thinking
    #: is never parsed or executed as a tool call.
    text_section_end: int | None = None


def has_assistant_sections(text: str) -> bool:
    """True when the assistant block uses the sectioned format.

    Blocks without any marker are plain text, which is the pre-existing format and
    stays supported.
    """
    return _SECTION_MARKER_RE.search(text) is not None


def split_assistant_sections(text: str) -> list[AssistantSection]:
    """Split an assistant block into its thinking/text sections.

    A block with no markers yields a single text section with the whole content.
    Content appearing before the first marker is also treated as text.
    """
    if not has_assistant_sections(text):
        return [AssistantSection(type="text", content=text)]

    parts = _SECTION_MARKER_RE.split(text)
    sections: list[AssistantSection] = []

    if parts and parts[0].strip() != "":
        sections.append(AssistantSection(type="text", content=parts[0]))

    for i in range(1, len(parts), 2):
        kind: Literal["thinking", "text"] = "thinking" if parts[i].lower() == "thinking" else "text"
        content = parts[i + 1] if i + 1 < len(parts) else ""
        sections.append(AssistantSection(type=kind, content=content))

    return sections


def parse_thinking_section(content: str) -> ParsedThinkingSection:
    """Parse a thinking section.

    The last non-empty line is the signature line when it matches
    "qualified_model_name::hash8", and is not part of the thinking text.
    """
    lines = re.split(r"\r?\n", content)

    last_non_empty = -1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip() != "":
            last_non_empty = i
            break

    if last_non_empty == -1:
        return ParsedThinkingSection(text="")

    match = _SIGNATURE_LINE_RE.match(lines[last_non_empty].strip())
    if not match:
        return ParsedThinkingSection(text=content.strip())

    model = match.group(1).strip()
    if not model:
        return ParsedThinkingSection(text=content.strip())

    return ParsedThinkingSection(
        text="\n".join(lines[:last_non_empty]).strip(),
        model=model,
        hash=match.group(2),
    )


def format_signature_line(model: str, hash_: str) -> str:
    """Renders the trailing line of a thinking section."""
    return f"{model}::{hash_}"


def strip_thinking_sections(text: str) -> str:
    """Returns only the text sections of an assistant block.

    Used so tool call scanning never looks inside thinking text.
    """
    if not has_assistant_sections(text):
        return text
    return "\n".join(
        section.content for section in split_assistant_sections(text) if section.type == "text"
    )


def block_marker_prefix(text_before: str) -> str:
    """Whitespace to insert before a new ``# %%`` block marker."""
    if len(text_before) == 0:
        # Start of the document: the first marker needs nothing above it
        return ""
    if re.search(r"\n[ \t]*\r?\n$", text_before):
        # Already a blank line above
        return ""
    if re.search(r"\n$", text_before):
        return "\n"
    return "\n\n"


def render_stream_events(
    events: Sequence[StreamEvent],
    already_written: str,
    state: SectionState,
    record_payload: Callable[[str, ThinkingPayload], str | None],
    *,
    escape: Callable[[str, bool], str] = escape_markers,
) -> str:
    """Renders a batch of stream events into the text to append to the assistant block.

    Inserts section markers as the event kind changes and updates ``state`` in place.

    Writing is strictly append-only: a signature arriving after text has started
    opens another thinking section instead of editing the earlier one.

    ``record_payload`` stores the payload and returns its "model::hash" line, or
    None when the payload could not be stored.

    ``escape`` is applied to the model's own text, and deliberately not to the
    section markers emitted here: those are real markers and must stay readable as
    such. Escaping inside this function rather than after it keeps the offsets it
    records in ``state`` in the same coordinates as the document, and lets it pass
    the one thing escaping cannot work out for itself: whether the text lands at
    the start of a line.
    """
    out = ""

    def needs_newline() -> bool:
        so_far = already_written + out
        return len(so_far) > 0 and not so_far.endswith("\n")

    def emit(text: str) -> str:
        """Escape content against its real position in the document."""
        so_far = already_written + out
        return escape(text, so_far == "" or so_far.endswith("\n"))

    def open_thinking_section() -> None:
        nonlocal out
        # Thinking closes whatever text section preceded it. Freeze the scannable
        # region here so the thinking text that follows is never scanned for tool
        # calls, while a tool call completed in the text before it still is.
        #
        # A text section is only actually open when one was started after the last
        # thinking section (text_open), or when no thinking has appeared yet and the
        # whole block so far is text. Otherwise this call is opening a second
        # thinking section straight after a previous one (a signature ends a
        # section without ending the reasoning), and there is no text to scan:
        # collapse the region to scan_offset rather than letting it cover the
        # earlier thinking content.
        state.text_section_end = (
            len(already_written) + len(out)
            if state.text_open or not state.saw_thinking
            else state.scan_offset
        )
        if needs_newline():
            out += "\n"
        out += THINKING_SECTION_MARKER + "\n"
        state.saw_thinking = True
        state.text_open = False

    for event in events:
        if isinstance(event, UsageDelta):
            continue

        if isinstance(event, ThinkingPayloadDelta):
            signature_line = record_payload(event.model, event.payload)
            if signature_line is None:
                continue
            if not state.thinking_open:
                open_thinking_section()
            elif needs_newline():
                out += "\n"
            out += signature_line + "\n"
            # The signature always ends its thinking section
            state.thinking_open = False
            continue

        if isinstance(event, ThinkingDelta):
            if not event.text:
                continue
            if not state.thinking_open:
                open_thinking_section()
                state.thinking_open = True
            out += emit(event.text)
            continue

        if not isinstance(event, TextDelta):
            # Unknown event kind: skip rather than assert, so a provider that grows
            # a new event type degrades to dropping it instead of crashing a stream
            # mid-write. An assert would also vanish under `python -O`, leaving an
            # unchecked attribute access in its place.
            continue

        # Normal assistant text: once thinking has appeared, text must live under
        # a "## %% text" marker
        if state.saw_thinking and not state.text_open:
            if needs_newline():
                out += "\n"
            out += TEXT_SECTION_MARKER + "\n"
            state.text_open = True
            state.thinking_open = False
            # Tool call scanning starts after the marker, so thinking text and
            # signature lines can never be mistaken for a tool call
            state.scan_offset = len(already_written) + len(out)
            # The new text section is open, so it extends to the end of the block
            state.text_section_end = None
        out += emit(event.text)

    return out
