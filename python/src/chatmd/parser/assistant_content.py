"""Parsing a ``# %% assistant`` block into text and thinking content.

Port of ``parseAssistantContent`` and its ``appendWaitMarkerToLastToolCall``
helper in ``src/parser.ts``.
"""

from __future__ import annotations

import logging
from pathlib import Path

from chatmd.assets import assets_dir
from chatmd.markers import unescape_markers
from chatmd.render import parse_thinking_section, split_assistant_sections
from chatmd.thinking_map import get_thinking_entry
from chatmd.tools.call_parser import append_wait_marker_after_last_tool_call
from chatmd.types import Content, TextContent, ThinkingContent, ThinkingPayload

logger = logging.getLogger(__name__)


def _lookup_payload(
    base_dir: Path, assets_path: str, hash_: str
) -> ThinkingPayload | None:
    """Resolve a thinking hash against the on-disk map.

    Never raises. An unreadable or absent map degrades the thinking section to
    display-only text, which is strictly better than failing to parse a chat over
    a cache file.
    """
    try:
        entry = get_thinking_entry(assets_dir(base_dir, assets_path), hash_)
    except OSError as error:
        logger.debug("Could not read thinking map for %s: %s", hash_, error)
        return None
    if entry is None:
        logger.debug("No thinking_map entry for hash %s, treating as display only", hash_)
        return None
    _model, payload = entry
    return payload


def _append_wait_marker_to_last_tool_call(content: list[Content]) -> None:
    """Put the end-of-batch marker back after the last tool call, in place.

    Only text sections are considered: a tool call written inside thinking was
    never a call, so a marker must never be attached to one.
    """
    for index in range(len(content) - 1, -1, -1):
        item = content[index]
        if not isinstance(item, TextContent):
            continue
        with_marker = append_wait_marker_after_last_tool_call(item.value)
        if with_marker != item.value:
            content[index] = TextContent(value=with_marker)
            return


def parse_assistant_content(
    content: str,
    base_dir: Path | None = None,
    *,
    assets_path: str = "cmdassets",
    append_wait_marker: bool = False,
) -> list[Content]:
    """Parse an assistant block into content blocks.

    A block without any ``## %%`` marker is plain text, which keeps the original
    format working. When markers are present, thinking sections become thinking
    content and their trailing ``model::hash8`` line is resolved against the
    thinking map.

    ``append_wait_marker`` re-synthesises the end-of-batch marker after the last
    tool call. It is a stream-control signal that never lives in the document, but
    the model is told to always emit one, so replaying history without it would
    show the model its own past turns in a shape it was told not to produce.
    """
    result: list[Content] = []

    for section in split_assistant_sections(content):
        # After the split, never before: an escaped "## %%% text" line inside the
        # content would otherwise be restored to a real marker and split the block
        # somewhere the writer never intended.
        body = unescape_markers(section.content)

        if section.type == "text":
            text = body.strip()
            if text:
                result.append(TextContent(value=text))
            continue

        parsed = parse_thinking_section(body)
        if not parsed.text and not parsed.hash:
            # Empty thinking section, nothing to carry over
            continue

        payload = (
            _lookup_payload(base_dir, assets_path, parsed.hash)
            if parsed.hash and base_dir is not None
            else None
        )

        result.append(
            ThinkingContent(
                # The model comes from the signature line rather than the map
                # entry: the document is the record, and the line is what a reader
                # (and a later hand edit) actually sees.
                value=parsed.text,
                model=parsed.model,
                hash=parsed.hash,
                payload=payload,
            )
        )

    if append_wait_marker:
        _append_wait_marker_to_last_tool_call(result)

    return result
