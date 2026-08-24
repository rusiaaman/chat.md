"""Parsing a ``# %% user`` block's text into text/image content, resolving file
references along the way.

Port of ``parseUserContent`` and ``containsImageReference`` in ``src/parser.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from chatmd.fileio import file_exists, is_image_file, read_text, resolve_file_path
from chatmd.types import Content, ImageContent, TextContent

# Deliberately consumes surrounding whitespace (leading and trailing `\s*`), which
# means a reference swallows blank lines around it -- this shapes which text
# segments survive as separate blocks, so it is kept exactly as the TS regex has
# it rather than tightened.
_MARKDOWN_LINK_RE = re.compile(r"\s*\[(.*?)\]\((.*?)\)\s*")

# The optional fenced block right after the path is swallowed by the match, so a
# code block a user pasted under "Attached file at" never leaks into the
# surrounding text.
_ATTACHED_FILE_RE = re.compile(r"Attached file at\s+([^\n]+)(?:\n```[\s\S]*?\n```)?")

_HAS_FILE_EXTENSION_RE = re.compile(r"\.\w{2,5}$")

# System-block image guard. Deliberately looser than `fileio.is_image_file`: it
# also matches `.bmp`, which `is_image_file` does not treat as an image anywhere
# else in this package. Ported as-is from the TS `containsImageReference`.
_SYSTEM_BLOCK_MARKDOWN_IMAGE_RE = re.compile(
    r"\[[^\]]*\]\(([^)]+(\.(png|jpg|jpeg|gif|webp|bmp)))\)", re.IGNORECASE
)
_SYSTEM_BLOCK_ATTACHED_IMAGE_RE = re.compile(
    r"Attached file at\s+([^\n]+(\.(png|jpg|jpeg|gif|webp|bmp)))", re.IGNORECASE
)


@dataclass(frozen=True)
class _FileRef:
    path: str
    is_image: bool
    kind: Literal["markdown", "attached", "mcp_prompt"]
    start: int
    end: int


def _find_file_refs(text: str) -> list[_FileRef]:
    refs: list[_FileRef] = []

    for match in _MARKDOWN_LINK_RE.finditer(text):
        link_text = match.group(1)
        file_path = match.group(2)

        if link_text.startswith("MCP Prompt:"):
            refs.append(
                _FileRef(
                    path=file_path,
                    is_image=False,  # MCP prompts are always text
                    kind="mcp_prompt",
                    start=match.start(),
                    end=match.end(),
                )
            )
            continue

        # Heuristic: treat as a file reference if the link text is literally
        # "#file" or the path ends in something extension-shaped. This can
        # capture a non-file link too, but resolving the path settles it below.
        is_likely_file = link_text.lower() == "#file" or _HAS_FILE_EXTENSION_RE.search(
            file_path
        )
        if is_likely_file:
            refs.append(
                _FileRef(
                    path=file_path,
                    is_image=is_image_file(file_path),
                    kind="markdown",
                    start=match.start(),
                    end=match.end(),
                )
            )

    for match in _ATTACHED_FILE_RE.finditer(text):
        file_path = match.group(1).strip()
        refs.append(
            _FileRef(
                path=file_path,
                is_image=is_image_file(file_path),
                kind="attached",
                start=match.start(),
                end=match.end(),
            )
        )

    refs.sort(key=lambda ref: ref.start)
    return refs


def parse_user_content(text: str, base_dir: Path | None = None) -> list[Content]:
    """Parse a user block's text, resolving file/image references into content.

    With no ``base_dir`` there is nothing to resolve paths against, so the block
    is returned verbatim as a single text block -- this is the behaviour a
    caller sees when it has no document context at all, and must survive
    unchanged (some tools call this without ever having a real file on disk).
    """
    if base_dir is None:
        return [TextContent(value=text)]

    content: list[Content] = []
    current_index = 0

    for ref in _find_file_refs(text):
        if ref.start > current_index:
            text_segment = text[current_index : ref.start]
            if text_segment.strip():  # avoid empty/whitespace-only segments
                content.append(TextContent(value=text_segment))

        try:
            resolved_path = resolve_file_path(ref.path, base_dir)
            if file_exists(resolved_path):
                if ref.kind == "mcp_prompt":
                    file_content = read_text(resolved_path)
                    content.append(
                        TextContent(
                            value=file_content
                            or f"[Error: Could not read MCP prompt file: {ref.path}]"
                        )
                    )
                elif ref.is_image:
                    # Original, unresolved path: the document is the portable
                    # record, so it should keep pointing at what the author wrote.
                    content.append(ImageContent(path=ref.path))
                else:
                    file_content = read_text(resolved_path)
                    content.append(
                        TextContent(value=f"Attached file: {ref.path}\n```\n{file_content}\n```")
                    )
            else:
                content.append(TextContent(value=f"[File not found: {ref.path}]"))
        except Exception as error:  # noqa: BLE001 - mirrors the TS catch-and-annotate
            content.append(TextContent(value=f"[Error processing file: {ref.path} - {error}]"))

        current_index = ref.end

    if current_index < len(text):
        remaining_text = text[current_index:]
        if remaining_text.strip():
            content.append(TextContent(value=remaining_text))

    return content


def contains_image_reference(text: str) -> bool:
    """System-block image-reference guard: True if `text` looks like it points at
    an image, via either reference syntax.

    Used only to flag system blocks (images are not supported there); intentionally
    coarser than the real attachment path -- see the module-level regex comments.
    """
    return bool(
        _SYSTEM_BLOCK_MARKDOWN_IMAGE_RE.search(text)
        or _SYSTEM_BLOCK_ATTACHED_IMAGE_RE.search(text)
    )
