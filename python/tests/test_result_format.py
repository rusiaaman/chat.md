"""Tests for chatmd.tools.result_format.

Port target: ``src/utils/mcpResultFormatter.ts`` plus ``formatToolResult`` from
``src/tools/toolExecutor.ts``. Each test below uses ``tmp_path`` as the doc dir
and, where a binary/text asset is expected to land on disk, asserts both the
markdown link text and the file's actual bytes/content.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from chatmd.tools.result_format import (
    format_mcp_result,
    format_prompt_result,
    format_read_resource_result,
    format_tool_result,
)
from chatmd.types import (
    McpAudioContent,
    McpEmbeddedResource,
    McpImageContent,
    McpPromptMessage,
    McpPromptResult,
    McpReadResourceResult,
    McpResourceContents,
    McpResourceLink,
    McpTextContent,
    McpToolExecutionResult,
)


def _result(**kwargs: object) -> McpToolExecutionResult:
    defaults: dict[str, object] = {"server_id": "srv", "tool_name": "mytool", "content": []}
    defaults.update(kwargs)
    return McpToolExecutionResult(**defaults)  # type: ignore[arg-type]


def _only_asset_file(doc_dir: Path) -> Path:
    files = list((doc_dir / "cmdassets").glob("*"))
    assert len(files) == 1, f"expected exactly one asset file, found {files}"
    return files[0]


# --------------------------------------------------------------------------- #
# format_tool_result
# --------------------------------------------------------------------------- #


def test_format_tool_result_wraps_in_tool_result_tag() -> None:
    assert format_tool_result("abc") == "<tool_result>\nabc\n</tool_result>"


# --------------------------------------------------------------------------- #
# format_mcp_result: plain text
# --------------------------------------------------------------------------- #


def test_text_content_passes_through_unchanged(tmp_path: Path) -> None:
    result = _result(content=[McpTextContent(text="hello world")])
    assert format_mcp_result(result, tmp_path) == "hello world"


def test_blank_parts_are_filtered_out(tmp_path: Path) -> None:
    result = _result(
        content=[
            McpTextContent(text="first"),
            McpTextContent(text="   "),
            McpTextContent(text=""),
            McpTextContent(text="second"),
        ]
    )
    assert format_mcp_result(result, tmp_path) == "first\n\nsecond"


# --------------------------------------------------------------------------- #
# format_mcp_result: image / audio assets
# --------------------------------------------------------------------------- #


def test_image_content_is_written_to_disk_and_linked_relatively(tmp_path: Path) -> None:
    png_bytes = b"\x89PNG\r\n\x1a\nsome-fake-png-bytes"
    result = _result(
        content=[McpImageContent(data=base64.b64encode(png_bytes).decode(), mime_type="image/png")]
    )

    output = format_mcp_result(result, tmp_path)

    assert output.startswith("![mytool image 1](cmdassets/")
    assert output.endswith(".png)")
    link = output[output.index("(") + 1 : -1]
    asset_path = tmp_path / link
    assert asset_path.is_file()
    assert asset_path.read_bytes() == png_bytes
    assert asset_path == _only_asset_file(tmp_path)


def test_multiple_images_get_an_incrementing_caption_count(tmp_path: Path) -> None:
    result = _result(
        content=[
            McpImageContent(data=base64.b64encode(b"one").decode(), mime_type="image/png"),
            McpImageContent(data=base64.b64encode(b"two").decode(), mime_type="image/png"),
        ]
    )

    output = format_mcp_result(result, tmp_path)

    assert "![mytool image 1](" in output
    assert "![mytool image 2](" in output


def test_audio_content_is_written_to_disk_and_linked_relatively(tmp_path: Path) -> None:
    audio_bytes = b"RIFF-fake-wav-bytes"
    audio_data = base64.b64encode(audio_bytes).decode()
    result = _result(content=[McpAudioContent(data=audio_data, mime_type="audio/wav")])

    output = format_mcp_result(result, tmp_path)

    assert output.startswith("[mytool audio 1](cmdassets/")
    assert output.endswith(".wav)")
    link = output[output.index("(") + 1 : -1]
    asset_path = tmp_path / link
    assert asset_path.is_file()
    assert asset_path.read_bytes() == audio_bytes


# --------------------------------------------------------------------------- #
# format_mcp_result: resource links
# --------------------------------------------------------------------------- #


def test_resource_link_without_server_id_has_no_fetch_instruction(tmp_path: Path) -> None:
    # McpToolExecutionResult.server_id is always populated (tool results always
    # know their source server) -- the "no known server" path only arises for
    # prompt messages, which pass sourceServerId=None. Exercise it there.
    prompt_result = McpPromptResult(
        messages=[
            McpPromptMessage(
                role="user",
                content=[
                    McpResourceLink(
                        uri="file:///a.md",
                        name="a.md",
                        title="A doc",
                        description="desc",
                        mime_type="text/markdown",
                    )
                ],
            )
        ]
    )

    output = format_prompt_result(prompt_result, tmp_path)

    assert output == "**Resource Link:** [A doc](file:///a.md) - desc · text/markdown"
    assert "system.fetch_mcp_resource" not in output


def test_resource_link_with_server_id_adds_fetch_instruction(tmp_path: Path) -> None:
    result = _result(
        server_id="docs-server",
        content=[McpResourceLink(uri="file:///a.md", name="a.md")],
    )

    output = format_mcp_result(result, tmp_path)

    assert output == (
        "**Resource Link:** [a.md](file:///a.md)\n"
        "To fetch this resource, call `system.fetch_mcp_resource` with "
        "`serverId` = `docs-server` and `uri` = `file:///a.md`."
    )


def test_resource_link_label_falls_back_to_uri_when_no_title_or_name(tmp_path: Path) -> None:
    result = _result(content=[McpResourceLink(uri="file:///x", name="")])
    output = format_mcp_result(result, tmp_path)
    assert output.startswith("**Resource Link:** [file:///x](file:///x)")


# --------------------------------------------------------------------------- #
# format_mcp_result: embedded resources
# --------------------------------------------------------------------------- #


def test_short_embedded_text_resource_is_inlined(tmp_path: Path) -> None:
    text = "line1\nline2\nline3"
    resource = McpResourceContents(uri="file:///short.txt", text=text)
    result = _result(content=[McpEmbeddedResource(resource=resource)])

    output = format_mcp_result(result, tmp_path)

    assert output == f"**Embedded Resource: file:///short.txt**\n\n```\n{text}\n```"
    assert not (tmp_path / "cmdassets").exists()


def test_long_embedded_text_resource_is_written_to_a_file_and_linked(tmp_path: Path) -> None:
    text = "\n".join(f"line {i}" for i in range(16))  # 16 lines > 15-line threshold
    resource = McpResourceContents(uri="file:///long.txt", text=text, mime_type="text/plain")
    result = _result(content=[McpEmbeddedResource(resource=resource)])

    output = format_mcp_result(result, tmp_path)

    assert output.startswith("[Embedded Resource: file:///long.txt](cmdassets/")
    assert output.endswith(".txt)")
    link = output[output.index("(") + 1 : -1]
    asset_path = tmp_path / link
    assert asset_path.is_file()
    assert asset_path.read_text(encoding="utf-8") == text


def test_embedded_resource_at_exactly_fifteen_lines_is_still_inlined(tmp_path: Path) -> None:
    text = "\n".join(f"line {i}" for i in range(15))  # exactly the <= 15 boundary
    resource = McpResourceContents(uri="file:///edge.txt", text=text)
    result = _result(content=[McpEmbeddedResource(resource=resource)])

    output = format_mcp_result(result, tmp_path)

    assert output.startswith("**Embedded Resource: file:///edge.txt**")
    assert not (tmp_path / "cmdassets").exists()


def test_embedded_blob_resource_is_base64_decoded_to_a_file_and_linked(tmp_path: Path) -> None:
    blob_bytes = b"raw-binary-blob-data"
    result = _result(
        content=[
            McpEmbeddedResource(
                resource=McpResourceContents(
                    uri="file:///blob.bin",
                    blob=base64.b64encode(blob_bytes).decode(),
                    mime_type="application/octet-stream",
                )
            )
        ]
    )

    output = format_mcp_result(result, tmp_path)

    assert output.startswith("[Embedded Binary Resource: file:///blob.bin](cmdassets/")
    link = output[output.index("(") + 1 : -1]
    asset_path = tmp_path / link
    assert asset_path.is_file()
    assert asset_path.read_bytes() == blob_bytes


def test_embedded_resource_with_neither_text_nor_blob_is_a_bare_pointer(tmp_path: Path) -> None:
    result = _result(
        content=[McpEmbeddedResource(resource=McpResourceContents(uri="file:///empty"))]
    )
    output = format_mcp_result(result, tmp_path)
    assert output == "[Embedded Resource: file:///empty]"


# --------------------------------------------------------------------------- #
# format_mcp_result: structured content and errors
# --------------------------------------------------------------------------- #


def test_structured_content_is_prepended_as_a_fenced_json_block(tmp_path: Path) -> None:
    result = _result(
        content=[McpTextContent(text="body")],
        structured_content={"a": 1, "b": [1, 2]},
    )

    output = format_mcp_result(result, tmp_path)

    expected_json = json.dumps({"a": 1, "b": [1, 2]}, indent=2)
    assert output == f"```json\n{expected_json}\n```\n\nbody"


def test_structured_content_alone_with_no_other_parts(tmp_path: Path) -> None:
    result = _result(content=[], structured_content={"only": True})
    output = format_mcp_result(result, tmp_path)
    expected_json = json.dumps({"only": True}, indent=2)
    assert output == f"```json\n{expected_json}\n```"


def test_error_result_gets_the_error_prefix(tmp_path: Path) -> None:
    result = _result(content=[McpTextContent(text="boom")], is_error=True)
    output = format_mcp_result(result, tmp_path)
    assert output == "**Tool execution error**\n\nboom"


def test_non_error_result_has_no_error_prefix(tmp_path: Path) -> None:
    result = _result(content=[McpTextContent(text="fine")], is_error=False)
    output = format_mcp_result(result, tmp_path)
    assert not output.startswith("**Tool execution error**")


# --------------------------------------------------------------------------- #
# format_prompt_result
# --------------------------------------------------------------------------- #


def test_assistant_prompt_message_gets_the_block_marker_prefix(tmp_path: Path) -> None:
    result = McpPromptResult(
        messages=[
            McpPromptMessage(role="user", content=[McpTextContent(text="hi")]),
            McpPromptMessage(role="assistant", content=[McpTextContent(text="hello back")]),
        ]
    )

    output = format_prompt_result(result, tmp_path)

    assert output == "hi\n\n# %% assistant\nhello back"


def test_prompt_message_with_blank_body_is_skipped(tmp_path: Path) -> None:
    result = McpPromptResult(
        messages=[
            McpPromptMessage(role="user", content=[McpTextContent(text="   ")]),
            McpPromptMessage(role="assistant", content=[McpTextContent(text="kept")]),
        ]
    )

    output = format_prompt_result(result, tmp_path)

    assert output == "# %% assistant\nkept"


def test_prompt_message_images_are_labelled_by_role(tmp_path: Path) -> None:
    image_data = base64.b64encode(b"img").decode()
    result = McpPromptResult(
        messages=[
            McpPromptMessage(
                role="assistant",
                content=[McpImageContent(data=image_data, mime_type="image/png")],
            )
        ]
    )

    output = format_prompt_result(result, tmp_path)

    assert "![prompt-assistant image 1](" in output
    assert output.startswith("# %% assistant\n")


# --------------------------------------------------------------------------- #
# format_read_resource_result
# --------------------------------------------------------------------------- #


def test_read_resource_result_with_text_returns_text_directly() -> None:
    contents = [McpResourceContents(uri="file:///x", text="some text")]
    result = McpReadResourceResult(contents=contents)
    assert format_read_resource_result(result) == "some text"


def test_read_resource_result_with_blob_describes_it_without_writing_a_file() -> None:
    blob = base64.b64encode(b"xx").decode()
    result = McpReadResourceResult(
        contents=[McpResourceContents(uri="file:///y", blob=blob, mime_type="application/pdf")]
    )

    output = format_read_resource_result(result)

    expected = (
        f"Binary resource: file:///y\n"
        f"MIME type: application/pdf\n"
        f"Payload: base64 blob ({len(blob)} chars)"
    )
    assert output == expected


def test_read_resource_result_blob_with_unknown_mime_type() -> None:
    blob = base64.b64encode(b"z").decode()
    result = McpReadResourceResult(contents=[McpResourceContents(uri="file:///z", blob=blob)])

    output = format_read_resource_result(result)

    assert "MIME type: unknown" in output


def test_read_resource_result_joins_multiple_contents_with_blank_line() -> None:
    result = McpReadResourceResult(
        contents=[
            McpResourceContents(uri="file:///a", text="first"),
            McpResourceContents(uri="file:///b", text="second"),
        ]
    )
    assert format_read_resource_result(result) == "first\n\nsecond"
