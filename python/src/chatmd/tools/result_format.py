"""Markdown rendering of MCP tool/prompt/resource results.

Port of ``src/utils/mcpResultFormatter.ts`` in full, plus ``formatToolResult``
from ``src/tools/toolExecutor.ts``. The TS functions are ``async`` purely
because they write files to disk (``fs.writeFileSync`` is actually
synchronous under the hood there too) -- these ports do the same writes with
plain synchronous calls, so nothing here is ``async def``.
"""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path

from chatmd.assets import (
    asset_file_name,
    assets_dir,
    assets_relative_path,
    extension_for_mime_type,
    write_binary_asset,
)
from chatmd.fileio import ensure_dir, write_text
from chatmd.types import (
    McpAudioContent,
    McpEmbeddedResource,
    McpImageContent,
    McpPromptResult,
    McpReadResourceResult,
    McpRenderableContent,
    McpResourceContents,
    McpResourceLink,
    McpTextContent,
    McpToolExecutionResult,
)

logger = logging.getLogger(__name__)

#: Line count at/below which an embedded text resource is inlined as a fenced
#: block rather than written to an asset file. Port of the ``<= 15`` check in
#: ``renderEmbeddedResource``.
_EMBEDDED_TEXT_INLINE_THRESHOLD = 15


def format_mcp_result(
    result: McpToolExecutionResult,
    doc_dir: Path,
    assets_path: str = "cmdassets",
) -> str:
    """Port of ``formatMcpResult``.

    Renders ``result.content`` to markdown, saving binary/oversized parts into
    the assets directory, then prepends structured content as a fenced json
    block and prefixes an error marker when ``result.is_error`` is set.
    """
    parts = _format_renderable_content(
        result.content, doc_dir, result.tool_name, result.server_id, assets_path
    )

    if result.structured_content is not None:
        structured_content_text = json.dumps(result.structured_content, indent=2)
        parts.insert(0, f"```json\n{structured_content_text}\n```")

    final_markdown = _join_markdown_parts(parts)
    if result.is_error:
        return f"**Tool execution error**\n\n{final_markdown}"

    return final_markdown


def format_prompt_result(
    result: McpPromptResult,
    doc_dir: Path,
    assets_path: str = "cmdassets",
) -> str:
    """Port of ``formatPromptResult``.

    Each message is rendered like a tool result's content list, keyed by
    ``prompt-<role>`` for asset naming, then an assistant message is prefixed
    with a ``# %% assistant`` marker line so it re-parses as its own block.
    """
    message_blocks: list[str] = []

    for message in result.messages:
        message_parts = _format_renderable_content(
            message.content, doc_dir, f"prompt-{message.role}", None, assets_path
        )
        message_body = _join_markdown_parts(message_parts)
        if message_body.strip() == "":
            continue

        if message.role == "assistant":
            message_blocks.append(f"# %% assistant\n{message_body}")
        else:
            message_blocks.append(message_body)

    return _join_markdown_parts(message_blocks)


def format_read_resource_result(result: McpReadResourceResult) -> str:
    """Port of ``formatReadResourceResult``. Never writes files -- a raw read,
    not a tool/prompt result, so a binary payload is only described, not saved.
    """
    parts: list[str] = []

    for content in result.contents:
        if content.text is not None:
            parts.append(content.text)
            continue

        if content.blob is not None:
            binary_header = "\n".join(
                [
                    f"Binary resource: {content.uri}",
                    f"MIME type: {content.mime_type or 'unknown'}",
                    f"Payload: base64 blob ({len(content.blob)} chars)",
                ]
            )
            parts.append(binary_header)

    return _join_markdown_parts(parts)


def format_tool_result(result: str) -> str:
    """Port of ``formatToolResult``: the ``<tool_result>`` wrapper inserted into
    the document after a tool call finishes."""
    return f"<tool_result>\n{result}\n</tool_result>"


def _format_renderable_content(
    content: list[McpRenderableContent],
    doc_dir: Path,
    asset_label: str,
    source_server_id: str | None,
    assets_path: str,
) -> list[str]:
    """Port of ``formatRenderableContent``.

    Text passes through untouched; images/audio/blobs are decoded and written
    into the assets directory and referenced by a doc-relative markdown link;
    a resource link is rendered as a pointer (plus a fetch instruction when the
    source server is known); an embedded resource is delegated to
    ``_render_embedded_resource``. Blank parts are dropped, matching the TS
    ``parts.filter(part => part.trim().length > 0)`` at the end.
    """
    parts: list[str] = []
    image_count = 0
    audio_count = 0
    resource_count = 0

    for item in content:
        if isinstance(item, McpTextContent):
            parts.append(item.text)
            continue

        if isinstance(item, McpImageContent):
            image_count += 1
            data = base64.b64decode(item.data)
            rel_path = write_binary_asset(
                doc_dir, data, item.mime_type, f"{asset_label}-image", assets_path
            )
            logger.debug("Saved MCP asset to: %s", rel_path)
            parts.append(f"![{asset_label} image {image_count}]({rel_path})")
            continue

        if isinstance(item, McpAudioContent):
            audio_count += 1
            data = base64.b64decode(item.data)
            rel_path = write_binary_asset(
                doc_dir, data, item.mime_type, f"{asset_label}-audio", assets_path
            )
            logger.debug("Saved MCP asset to: %s", rel_path)
            parts.append(f"[{asset_label} audio {audio_count}]({rel_path})")
            continue

        if isinstance(item, McpResourceLink):
            label = item.title or item.name or item.uri
            detail_parts = [part for part in (item.description, item.mime_type) if part]
            detail = f" - {' · '.join(detail_parts)}" if detail_parts else ""
            fetch_instruction = (
                f"\nTo fetch this resource, call `system.fetch_mcp_resource` with "
                f"`serverId` = `{source_server_id}` and `uri` = `{item.uri}`."
                if source_server_id
                else ""
            )
            parts.append(f"**Resource Link:** [{label}]({item.uri}){detail}{fetch_instruction}")
            continue

        # The only remaining member of the McpRenderableContent union is the
        # embedded-resource variant.
        assert isinstance(item, McpEmbeddedResource)
        resource_count += 1
        resource_label = f"{asset_label}-resource-{resource_count}"
        parts.append(_render_embedded_resource(item.resource, doc_dir, resource_label, assets_path))

    return [part for part in parts if part.strip() != ""]


def _render_embedded_resource(
    resource: McpResourceContents,
    doc_dir: Path,
    resource_label: str,
    assets_path: str,
) -> str:
    """Port of ``renderEmbeddedResource``: inline short text, else write text or
    blob to an asset file and link it; a resource with neither is a bare pointer.
    """
    if resource.text is not None:
        line_count = len(resource.text.split("\n"))
        if line_count <= _EMBEDDED_TEXT_INLINE_THRESHOLD:
            return f"**Embedded Resource: {resource.uri}**\n\n```\n{resource.text}\n```"

        extension = extension_for_mime_type(resource.mime_type or "text/plain", ".txt")
        rel_path = _write_text_asset(doc_dir, resource.text, extension, resource_label, assets_path)
        logger.debug("Saved embedded text resource to: %s", rel_path)
        return f"[Embedded Resource: {resource.uri}]({rel_path})"

    if resource.blob is not None:
        mime_type = resource.mime_type or "application/octet-stream"
        data = base64.b64decode(resource.blob)
        rel_path = write_binary_asset(doc_dir, data, mime_type, resource_label, assets_path)
        logger.debug("Saved embedded binary resource to: %s", rel_path)
        return f"[Embedded Binary Resource: {resource.uri}]({rel_path})"

    return f"[Embedded Resource: {resource.uri}]"


def _write_text_asset(
    doc_dir: Path,
    text: str,
    extension: str,
    label: str,
    assets_path: str,
) -> str:
    """Write text into the assets directory and return its doc-relative path.

    ``chatmd.assets`` only offers a binary writer (``write_binary_asset``); this
    composes the same primitives it uses internally for the text case.
    """
    directory = assets_dir(doc_dir, assets_path)
    ensure_dir(directory)
    file_name = asset_file_name(label, extension)
    write_text(directory / file_name, text)
    return assets_relative_path(doc_dir, file_name, assets_path)


def _join_markdown_parts(parts: list[str]) -> str:
    """Port of ``joinMarkdownParts``: drop blank parts, join the rest with a
    blank line."""
    return "\n\n".join(part for part in parts if part.strip() != "")
