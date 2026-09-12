"""Parsing a ``# %% assistant`` block into text and thinking content.

Port of ``parseAssistantContent`` and its ``appendWaitMarkerToLastToolCall``
helper in ``src/parser.ts``.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from chatmd.assets import assets_dir
from chatmd.markers import unescape_markers
from chatmd.parser.tool_result import parse_tool_result_content
from chatmd.providers.native_tools import parse_server_tool_result
from chatmd.render import parse_thinking_section, split_assistant_sections
from chatmd.thinking_map import get_thinking_entry
from chatmd.tools.call_parser import find_all_tool_calls, parse_tool_call
from chatmd.types import (
    Content,
    TextContent,
    ThinkingContent,
    ThinkingPayload,
    ToolResultContent,
    ToolUseContent,
)

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


def _tool_use_id(raw_xml: str, ordinal: int) -> str:
    digest = hashlib.sha256(f"{ordinal}:{raw_xml}".encode()).hexdigest()[:24]
    return f"chatmd_{digest}"


def _parse_text_and_tools(text: str, server_tool: bool) -> list[Content]:
    """Split display text around calls and turn every complete call into data."""
    output: list[Content] = []
    calls = find_all_tool_calls(text)
    cursor = 0
    for ordinal, raw_xml in enumerate(calls):
        start = text.find(raw_xml, cursor)
        before = text[cursor:start].strip()
        if before:
            output.append(TextContent(value=before))
        parsed = parse_tool_call(raw_xml)
        if parsed is not None:
            output.append(
                ToolUseContent(
                    id=parsed.id or _tool_use_id(raw_xml, ordinal),
                    name=parsed.name,
                    input=(
                        parsed.input
                        if parsed.input is not None
                        else {
                            key: _parse_legacy_value(value)
                            for key, value in parsed.params.items()
                        }
                    ),
                    raw_xml=raw_xml,
                    server_tool=server_tool,
                )
            )
        else:
            output.append(TextContent(value=raw_xml))
        cursor = start + len(raw_xml)
    after = text[cursor:].strip()
    if after:
        output.append(TextContent(value=after))
    return output


def _parse_legacy_value(value: str) -> object:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def parse_assistant_content(
    content: str,
    base_dir: Path | None = None,
    *,
    assets_path: str = "cmdassets",
) -> list[Content]:
    """Parse an assistant block into content blocks.

    A block without any ``## %%`` marker is plain text, which keeps the original
    format working. When markers are present, thinking sections become thinking
    content and their trailing ``model::hash8`` line is resolved against the
    thinking map.

    Complete tool calls are emitted as :class:`ToolUseContent` values. Providers
    decide whether to replay those as native items or the custom Google syntax.
    """
    result: list[Content] = []
    server_tool_uses: list[ToolUseContent] = []
    server_result_index = 0

    for section in split_assistant_sections(content):
        # After the split, never before: an escaped "## %%% text" line inside the
        # content would otherwise be restored to a real marker and split the block
        # somewhere the writer never intended.
        body = unescape_markers(section.content)

        if section.type == "text":
            text = body.strip()
            if text:
                result.extend(_parse_text_and_tools(text, False))
            continue

        if section.type == "server_tool":
            parsed_tools = _parse_text_and_tools(body.strip(), True)
            result.extend(parsed_tools)
            server_tool_uses.extend(
                item for item in parsed_tools if isinstance(item, ToolUseContent)
            )
            continue

        if section.type == "server_tool_results":
            tool_use_id, result_body = parse_server_tool_result(body.strip())
            if not result_body.strip():
                continue
            tool_use = (
                next(
                    (item for item in server_tool_uses if item.id == tool_use_id),
                    None,
                )
                if tool_use_id is not None
                else server_tool_uses[server_result_index]
                if server_result_index < len(server_tool_uses)
                else None
            )
            if tool_use is None:
                continue
            native_content, raw_text = parse_tool_result_content(
                result_body.strip(), base_dir
            )
            result.append(
                ToolResultContent(
                    tool_use_id=tool_use.id,
                    name=tool_use.name,
                    content=native_content,
                    raw_text=raw_text,
                    is_error=any(
                        isinstance(item, TextContent)
                        and item.value.lstrip().startswith("Error:")
                        for item in native_content
                    ),
                    server_tool=True,
                )
            )
            if tool_use_id is None:
                server_result_index += 1
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

    return result
