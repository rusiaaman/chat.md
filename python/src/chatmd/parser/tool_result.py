"""Turning a ``# %% tool_execute`` block back into message content.

Port of ``processToolResultContent`` in ``src/parser.ts``. Tool results are
replayed to the model as user messages, and this is where a result that was
written to a file (because it was too long to inline) gets read back in, and where
images a tool produced become real image content rather than a markdown link.
"""

from __future__ import annotations

import re
from pathlib import Path

# Same reasoning as parser/user_content.py: a tool result that links a file is
# re-read on every parse of the document it lives in.
from chatmd.fileio import (
    file_exists,
    is_image_file,
    resolve_file_path,
)
from chatmd.fileio import read_text_cached as read_text
from chatmd.types import ImageContent, TextContent

_TOOL_RESULT_RE = re.compile(r"<tool_result>(.*?)</tool_result>", re.DOTALL)

# Deliberately broader than fileio.is_image_file, which does not list .bmp. Kept
# as the TS has it so a bmp a tool emitted is still split out as an image.
_IMAGE_MARKDOWN_RE = re.compile(
    r"!\[[^\]]*\]\(([^)]+\.(?:png|jpg|jpeg|gif|webp|bmp))\)", re.IGNORECASE
)

# No MULTILINE, so the anchors bind to the whole string: the fence is only
# stripped when the entire result *is* one fenced block.
_WHOLE_FENCE_RE = re.compile(r"^```.*?```$", re.DOTALL)
_FENCE_BODY_RE = re.compile(r"```(?:.*?)?\n(.*?)\n```", re.DOTALL)

_SINGLE_LINK_RE = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)$")


def _strip_whole_code_fence(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        body = _FENCE_BODY_RE.search(match.group(0))
        return body.group(1).strip() if body else match.group(0)

    return _WHOLE_FENCE_RE.sub(replace, text)


def _split_out_images(body: str) -> list[TextContent | ImageContent]:
    """Interleave the text and image links a tool result contains."""
    content: list[TextContent | ImageContent] = []
    last_index = 0

    for match in _IMAGE_MARKDOWN_RE.finditer(body):
        if match.start() > last_index:
            before = body[last_index : match.start()].strip()
            if before:
                content.append(TextContent(value=before))
        content.append(ImageContent(path=match.group(1)))
        last_index = match.end()

    if last_index < len(body):
        after = body[last_index:].strip()
        if after:
            content.append(TextContent(value=after))

    return content


def process_tool_result_content(
    content: str, base_dir: Path | None = None
) -> list[TextContent | ImageContent]:
    """Parse a tool_execute block, inlining linked results and extracting images."""
    if base_dir is None:
        return [TextContent(value=content)]

    match = _TOOL_RESULT_RE.search(content)
    if match is None:
        return [TextContent(value=content)]

    body = match.group(1).strip()

    if _IMAGE_MARKDOWN_RE.search(body):
        return _split_out_images(body)

    # A result that was too long to inline was written to a file and replaced by a
    # link. Read it back so the model sees the result itself, not a path.
    link_only = _strip_whole_code_fence(body).strip()
    link = _SINGLE_LINK_RE.match(link_only)
    if link is None:
        return [TextContent(value=content)]

    target = link.group(2)
    resolved = resolve_file_path(target, base_dir)
    if not file_exists(resolved):
        return [TextContent(value=content)]

    if is_image_file(resolved):
        return [ImageContent(path=target)]

    file_content = read_text(resolved)
    if not file_content:
        return [TextContent(value=content)]

    # Substituted back into the wrapper rather than replacing the whole block, so
    # any text the result carried around the link survives.
    replaced = _TOOL_RESULT_RE.sub(
        lambda _m: f"<tool_result>\n{file_content}\n</tool_result>", content, count=1
    )
    return [TextContent(value=replaced)]


def parse_tool_result_content(
    content: str, base_dir: Path | None
) -> tuple[list[TextContent | ImageContent], str]:
    """Return native result parts and the equivalent custom-protocol text."""
    processed = process_tool_result_content(content, base_dir)
    raw_text = content
    if len(processed) == 1 and isinstance(processed[0], TextContent):
        raw_text = processed[0].value

    native: list[TextContent | ImageContent] = []
    for item in processed:
        if isinstance(item, ImageContent):
            native.append(item)
            continue
        match = _TOOL_RESULT_RE.search(item.value)
        native.append(
            TextContent(value=match.group(1).strip() if match is not None else item.value)
        )
    return native, raw_text
