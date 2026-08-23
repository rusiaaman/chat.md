"""JSON-with-comments support for hand-edited config and editor settings files.

Editor settings files (and configs a user hand-commented) are JSON with ``//``
and ``/* */`` comments and trailing commas, neither of which ``json.loads``
accepts. This is a small hand-rolled character scanner rather than a regex,
because only a scanner can track whether the cursor is inside a string
literal — a regex has no state, so it cannot reliably tell a ``//`` that opens
a comment from one sitting inside a quoted value.
"""

from __future__ import annotations

import json
from typing import Any

_WHITESPACE = " \t\r\n"


def strip_jsonc(text: str) -> str:
    """Blank out comments and trailing commas, leaving plain JSON.

    Comments and elided commas are replaced with whitespace of the same
    length rather than deleted, so every remaining character keeps its
    original offset — a ``json.loads`` error position (and any surrounding
    text) still lines up with the source file.
    """
    return _strip_trailing_commas(_strip_comments(text))


def loads_jsonc(text: str) -> Any:
    """Parse JSONC text (comments and trailing commas tolerated)."""
    return json.loads(strip_jsonc(text))


def _strip_comments(text: str) -> str:
    """Replace ``//...`` and ``/*...*/`` comments with whitespace, strings untouched."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_string = False
    escaped = False
    while i < n:
        ch = text[i]

        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue

        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            # Blank the rest of the line; the newline itself is left for the
            # main loop to copy through untouched on the next iteration.
            while i < n and text[i] != "\n":
                out.append(" ")
                i += 1
            continue

        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            out.append(" ")
            out.append(" ")
            i += 2
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            if i < n:  # found the closing "*/"; an unterminated comment just ends at EOF
                out.append(" ")
                out.append(" ")
                i += 2
            continue

        out.append(ch)
        i += 1

    return "".join(out)


def _strip_trailing_commas(text: str) -> str:
    """Blank a comma that is only followed by whitespace before ``}`` or ``]``.

    Runs after comment stripping, so any comment between the comma and the
    closing bracket has already become whitespace and needs no special case
    here — only string state still needs tracking.
    """
    out = list(text)
    n = len(text)
    in_string = False
    escaped = False
    i = 0
    while i < n:
        ch = text[i]

        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            i += 1
            continue

        if ch == ",":
            j = i + 1
            while j < n and text[j] in _WHITESPACE:
                j += 1
            if j < n and text[j] in "}]":
                out[i] = " "

        i += 1

    return "".join(out)
