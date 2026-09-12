"""Parsing a whole ``.chat.md`` document into a message history.

Port of ``parseDocument`` in ``src/parser.ts``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from chatmd.markers import unescape_markers
from chatmd.types import (
    Content,
    ImageContent,
    MessageParam,
    ParsedDocument,
    TextContent,
    ToolResultContent,
    ToolUseContent,
)

from .assistant_content import parse_assistant_content
from .blocks import split_blocks
from .preamble import parse_preamble
from .settings import parse_settings_block
from .tool_result import parse_tool_result_content, process_tool_result_content
from .user_content import contains_image_reference, parse_user_content

logger = logging.getLogger(__name__)


def parse_document(
    text: str,
    base_dir: str | Path | None = None,
    *,
    assets_path: str = "cmdassets",
) -> ParsedDocument:
    """Parse a ``.chat.md`` document into messages plus its system prompt.

    The trailing empty ``assistant`` or ``tool_execute`` block is the action
    trigger, not conversation, so it is excluded from the returned history.
    """
    base = Path(base_dir) if base_dir is not None else None
    blocks = split_blocks(text)

    # Everything before the first marker is the configuration preamble. With no
    # markers at all the whole document is preamble, and prose there is an error --
    # that is what tells an author their block marker is malformed rather than
    # silently sending the file as nothing.
    preamble = text[: blocks[0].marker_start] if blocks else text
    file_config, has_configuration_block = parse_preamble(preamble)

    if blocks:
        last = blocks[-1]
        if last.type in ("assistant", "tool_execute") and not last.raw_content.strip():
            blocks = blocks[:-1]

    messages: list[MessageParam] = []
    system_parts: list[str] = []
    has_image_in_system_block = False
    settings: dict[str, Any] | None = None
    pending_tool_uses: list[ToolUseContent] = []
    pending_result_index = 0

    for block in blocks:
        # Unescaped here, once the document has already been split: content that
        # contains a marker line was written with an extra percent sign, and this
        # is where it becomes ordinary text again. Assistant blocks are the
        # exception -- they are unescaped after their sections are split, or an
        # escaped "## %%% text" would turn into a real section marker.
        raw = block.raw_content if block.type == "assistant" else unescape_markers(
            block.raw_content
        )
        content = raw.strip()

        if block.type == "settings":
            if content:
                settings = parse_settings_block(content)

        elif block.type == "system":
            if content:
                # Raw, not trimmed: a system prompt's own formatting is part of it.
                system_parts.append(raw)
                if not has_image_in_system_block and contains_image_reference(content):
                    has_image_in_system_block = True

        elif block.type == "tool_execute":
            # Results are replayed as user turns, which is how a model without
            # native tool support sees what its call produced.
            if content:
                if pending_result_index < len(pending_tool_uses):
                    tool_use = pending_tool_uses[pending_result_index]
                    native_content, raw_text = parse_tool_result_content(content, base)
                    messages.append(
                        MessageParam(
                            role="user",
                            content=[
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
                                )
                            ],
                        )
                    )
                    pending_result_index += 1
                else:
                    processed_content: list[Content] = list(
                        process_tool_result_content(content, base)
                    )
                    messages.append(
                        MessageParam(
                            role="user", content=processed_content
                        )
                    )

        elif block.type == "user":
            pending_tool_uses = []
            pending_result_index = 0
            parsed = parse_user_content(content, base)
            if any(
                (isinstance(item, TextContent) and item.value.strip())
                or isinstance(item, ImageContent)
                for item in parsed
            ):
                messages.append(MessageParam(role="user", content=parsed))
            else:
                logger.debug("Skipping user block that parsed to nothing")

        elif block.type == "assistant":
            if not content:
                continue
            parsed_assistant = parse_assistant_content(
                content,
                base,
                assets_path=assets_path,
            )
            if parsed_assistant:
                messages.append(MessageParam(role="assistant", content=parsed_assistant))
                pending_tool_uses = [
                    item for item in parsed_assistant if isinstance(item, ToolUseContent)
                ]
                pending_result_index = 0
            else:
                logger.debug("Skipping assistant block that parsed to empty content")

    return ParsedDocument(
        messages=messages,
        system_prompt="\n".join(system_parts).strip(),
        has_image_in_system_block=has_image_in_system_block,
        file_config=file_config,
        settings=settings,
        has_configuration_block=has_configuration_block,
    )
