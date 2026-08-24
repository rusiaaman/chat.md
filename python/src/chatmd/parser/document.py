"""Parsing a whole ``.chat.md`` document into a message history.

Port of ``parseDocument`` in ``src/parser.ts``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from chatmd.types import ImageContent, MessageParam, ParsedDocument, TextContent

from .assistant_content import parse_assistant_content
from .blocks import split_blocks
from .preamble import parse_preamble
from .settings import parse_settings_block
from .tool_result import process_tool_result_content
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

    for index, block in enumerate(blocks):
        content = block.raw_content.strip()

        if block.type == "settings":
            if content:
                settings = parse_settings_block(content)

        elif block.type == "system":
            if content:
                # Raw, not trimmed: a system prompt's own formatting is part of it.
                system_parts.append(block.raw_content)
                if not has_image_in_system_block and contains_image_reference(content):
                    has_image_in_system_block = True

        elif block.type == "tool_execute":
            # Results are replayed as user turns, which is how a model without
            # native tool support sees what its call produced.
            if content:
                messages.append(
                    MessageParam(
                        role="user", content=process_tool_result_content(content, base)
                    )
                )

        elif block.type == "user":
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
            # A tool_execute block after this one means the batch finished and ran,
            # so the end-of-batch marker belongs back in the replayed turn. Without
            # one the batch is still in flight (a resumed or partial assistant
            # block) and claiming it ended would be a lie.
            next_type = blocks[index + 1].type if index + 1 < len(blocks) else None
            parsed_assistant = parse_assistant_content(
                content,
                base,
                assets_path=assets_path,
                append_wait_marker=next_type == "tool_execute",
            )
            if parsed_assistant:
                messages.append(MessageParam(role="assistant", content=parsed_assistant))
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
