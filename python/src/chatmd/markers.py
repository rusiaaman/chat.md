"""Escaping block and section markers that appear inside content.

A ``.chat.md`` document is structured entirely by its ``# %%`` marker lines, so
content that happens to contain one tears the document apart: the block splits in
the wrong place, a ``<tool_result>`` wrapper loses its other half, and turns that
never happened appear in the history. That is not hypothetical — it is what
happens the moment a chat reads or writes another chat through a tool.

So anything written *into* a document is escaped by adding a percent sign, and
anything read back *out* of a block body has one removed:

    # %% user      written as   # %%% user
    # %%% user     written as   # %%%% user

Escaping the whole ladder rather than just the two-percent form is what makes it
reversible. If only ``%%`` were escaped, content that already contained
``# %%% user`` would pass through untouched and then *become* a real marker when
it was unescaped.

``unescape(escape(text)) == text`` holds for any text. The reverse deliberately
does not: a bare ``# %% user`` in a document is a real marker, and reading a block
body must never turn one into content.
"""

from __future__ import annotations

import re

#: Roles that open a top-level block.
BLOCK_ROLES = ("user", "assistant", "system", "tool_execute", "settings")
#: Roles that open a section inside an assistant block.
SECTION_ROLES = ("thinking", "text", "server_tool", "server_tool_results")

# Trailing whitespace is limited to spaces, tabs and a carriage return so these
# match exactly the *lines* the parser treats as markers. The parser's own regex
# ends in `\s*$`, which also swallows following newlines, but that affects where
# its match ends, not which lines count.
_TRAILING = r"([ \t\r]*)$"

_BLOCK_ESCAPABLE = re.compile(
    r"^# (%{2,}) (" + "|".join(BLOCK_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_SECTION_ESCAPABLE = re.compile(
    r"^## (%{2,}) (" + "|".join(SECTION_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
# Exactly two percent signs: the third character after `%%` must be a space, so
# these match precisely the lines the parser turns into blocks -- no more.
_BLOCK_MARKER = re.compile(
    r"^# %% (" + "|".join(BLOCK_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_SECTION_MARKER = re.compile(
    r"^## %% (" + "|".join(SECTION_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_BLOCK_ESCAPED = re.compile(
    r"^# %(%{2,}) (" + "|".join(BLOCK_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)
_SECTION_ESCAPED = re.compile(
    r"^## %(%{2,}) (" + "|".join(SECTION_ROLES) + r")" + _TRAILING,
    re.MULTILINE | re.IGNORECASE,
)


def _add_percent(match: re.Match[str], hashes: str) -> str:
    return f"{hashes} %{match.group(1)} {match.group(2)}{match.group(3)}"


def _drop_percent(match: re.Match[str], hashes: str) -> str:
    return f"{hashes} {match.group(1)} {match.group(2)}{match.group(3)}"


def _escape_all(text: str) -> str:
    text = _BLOCK_ESCAPABLE.sub(lambda match: _add_percent(match, "#"), text)
    return _SECTION_ESCAPABLE.sub(lambda match: _add_percent(match, "##"), text)


def escape_markers(text: str, at_line_start: bool = True) -> str:
    """Make marker-shaped lines safe to write into a document.

    Applied to everything the engine writes: streamed assistant text, tool
    results, and messages appended on a user's behalf.

    ``at_line_start`` says whether `text` will land at the start of a line in the
    document. It matters because a streamer escapes one batch at a time, and a
    batch that begins mid-line would otherwise have its first character treated as
    a line start: text arriving right after ``<cmd:param name="x">`` would be
    escaped as though it were a marker, and since unescaping (which does see whole
    lines) would not undo it, the escaping would never come back off.
    """
    if at_line_start:
        return _escape_all(text)
    head, separator, rest = text.partition("\n")
    if not separator:
        # Still inside the line it started in: nothing here can be a marker.
        return head
    return head + separator + _escape_all(rest)


def unescape_markers(text: str) -> str:
    """Restore marker-shaped lines when reading a block body back out.

    Only ever applied to content *inside* a block, never to a whole document: the
    document's own markers carry two percent signs and must stay markers.
    """
    text = _BLOCK_ESCAPED.sub(lambda match: _drop_percent(match, "#"), text)
    return _SECTION_ESCAPED.sub(lambda match: _drop_percent(match, "##"), text)


def contains_marker_line(text: str) -> bool:
    """Whether `text` holds a line the parser would read as a marker.

    Strictly two percent signs: an already-escaped ``# %%% user`` is content, and
    reporting it here would mean escaped text still looked dangerous.
    """
    return bool(_BLOCK_MARKER.search(text) or _SECTION_MARKER.search(text))


# A partial line that might still grow into a marker. Reached only for the tail of
# a stream batch, so it must accept every prefix of an escapable marker line and as
# little else as possible: holding a line back delays it reaching the reader.
#
#   "#", "##", "# ", "# %", "# %%", "# %% ", "# %% us", "# %% user"
#
# A markdown heading such as "# Introduction" is deliberately not matched — those
# are common in assistant output and would be held back on every line.
_COULD_BECOME_MARKER = re.compile(r"^#{1,2}( (%*|%{2,} [A-Za-z_]*))?$")


def could_become_marker_line(partial_line: str) -> bool:
    """Whether an unfinished line might still turn out to be a marker.

    A marker is only a marker once its line ends, so a streamer cannot judge
    ``# %% user`` until it sees the newline — the next token might make it
    ``# %% username``. This says whether the line is still in that undecided
    state and must be withheld.
    """
    return bool(_COULD_BECOME_MARKER.match(partial_line))
