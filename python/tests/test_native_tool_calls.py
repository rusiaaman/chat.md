from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from chatmd.config.model import ResolvedConfig
from chatmd.providers.anthropic_client import AnthropicClient
from chatmd.providers.native_tools import NativeToolDefinition, native_tool_name
from chatmd.providers.openai_chat import _translate_stream, format_messages
from chatmd.providers.openai_responses import (
    OpenAIResponsesClient,
    convert_to_responses_input_with_tools,
)
from chatmd.tools.call_parser import parse_tool_call
from chatmd.types import (
    MessageParam,
    ProviderType,
    TextContent,
    TextDelta,
    ToolResultContent,
    ToolUseContent,
)


def native_tool() -> NativeToolDefinition:
    return NativeToolDefinition(
        api_name=native_tool_name("system.fetch_mcp_resource"),
        name="system.fetch_mcp_resource",
        description="Read a resource",
        input_schema={
            "type": "object",
            "properties": {"uri": {"type": "string"}},
            "required": ["uri"],
        },
    )


def tool_history() -> list[MessageParam]:
    call = ToolUseContent(
        id="call_1",
        name="system.fetch_mcp_resource",
        input={"uri": "file://a<b"},
        raw_xml=(
            "<cmd:tool_call>\n"
            "<cmd:tool_name>system.fetch_mcp_resource</cmd:tool_name>\n"
            '<cmd:param name="uri">file://a&lt;b</cmd:param>\n'
            "</cmd:tool_call>"
        ),
    )
    result = ToolResultContent(
        tool_use_id="call_1",
        name=call.name,
        content=[TextContent(value="contents")],
        raw_text="<tool_result>\ncontents\n</tool_result>",
        is_error=False,
    )
    return [
        MessageParam(role="assistant", content=[call]),
        MessageParam(role="user", content=[result]),
    ]


async def events(items: list[Any]) -> Any:
    for item in items:
        yield item


def config(provider: ProviderType, model: str) -> ResolvedConfig:
    return ResolvedConfig(
        provider=provider,
        api_key="k",
        model_name=model,
        reasoning_effort="none",
    )


def text(events_: list[Any]) -> str:
    return "".join(event.text for event in events_ if isinstance(event, TextDelta))


def test_anthropic_request_uses_mcp_schema_and_native_history() -> None:
    tool = native_tool()
    client = AnthropicClient(config("anthropic", "claude-sonnet-4-5"))
    request = client._build_request(tool_history(), "system", [tool])

    assert request["tools"] == [
        {
            "name": tool.api_name,
            "description": tool.description,
            "input_schema": tool.input_schema,
        }
    ]
    assert request["messages"][0]["content"][0] == {
        "type": "tool_use",
        "id": "call_1",
        "name": tool.api_name,
        "input": {"uri": "file://a<b"},
    }
    assert request["messages"][1]["content"][0]["type"] == "tool_result"


def test_google_model_keeps_custom_protocol_and_receives_no_native_schemas() -> None:
    client = AnthropicClient(config("anthropic", "google-gemini-2.5-pro"))
    request = client._build_request(tool_history(), "system", [native_tool()])

    assert "tools" not in request
    assistant_text = "".join(
        block["text"] for block in request["messages"][0]["content"]
    )
    assert "<cmd:tool_call>" in assistant_text
    assert "<cmd:wait-tool-result/>" in assistant_text


async def test_anthropic_partial_json_is_rendered_as_parseable_chat_call() -> None:
    tool = native_tool()
    client = AnthropicClient(config("anthropic", "claude-sonnet-4-5"))
    raw = [
        SimpleNamespace(
            type="content_block_start",
            index=0,
            content_block=SimpleNamespace(
                type="tool_use", id="call_1", name=tool.api_name, input={}
            ),
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=0,
            delta=SimpleNamespace(
                type="input_json_delta", partial_json='{"uri":"file://a<'
            ),
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=0,
            delta=SimpleNamespace(type="input_json_delta", partial_json='b"}'),
        ),
        SimpleNamespace(type="content_block_stop", index=0),
    ]

    translated = [
        event
        async for event in client._iter_stream_events(
            events(raw), "claude-sonnet-4-5", [tool]
        )
    ]
    parsed = parse_tool_call(text(translated).strip())
    assert parsed is not None
    assert parsed.id == "call_1"
    assert parsed.name == tool.name
    assert parsed.input == {"uri": "file://a<b"}


def test_openai_chat_history_uses_tool_call_and_tool_result_roles() -> None:
    tool = native_tool()
    formatted = format_messages(tool_history(), [tool], True, None)

    assert formatted[0]["tool_calls"][0]["function"]["name"] == tool.api_name
    assert formatted[1] == {
        "role": "tool",
        "tool_call_id": "call_1",
        "content": "contents",
    }


async def test_openai_chat_argument_fragments_form_one_chat_call() -> None:
    tool = native_tool()
    name_split = len(tool.api_name) // 2
    raw = [
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(
                        tool_calls=[
                            SimpleNamespace(
                                index=0,
                                id="call_1",
                                function=SimpleNamespace(
                                    name=tool.api_name[:name_split], arguments=None
                                ),
                            )
                        ]
                    ),
                    finish_reason=None,
                )
            ],
        ),
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(
                        tool_calls=[
                            SimpleNamespace(
                                index=0,
                                id=None,
                                function=SimpleNamespace(
                                    name=tool.api_name[name_split:], arguments='{"uri":"a'
                                ),
                            )
                        ]
                    ),
                    finish_reason=None,
                )
            ],
        ),
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(
                        tool_calls=[
                            SimpleNamespace(
                                index=0,
                                id=None,
                                function=SimpleNamespace(name=None, arguments='<b"}'),
                            )
                        ]
                    ),
                    finish_reason="tool_calls",
                )
            ],
        ),
    ]

    translated = [
        event async for event in _translate_stream(events(raw), "gpt-5", [tool])
    ]
    parsed = parse_tool_call(text(translated).strip())
    assert parsed is not None
    assert parsed.input == {"uri": "a<b"}


def test_responses_history_uses_function_call_items() -> None:
    tool = native_tool()
    items = convert_to_responses_input_with_tools(tool_history(), [tool], True, None)

    assert items[0]["type"] == "function_call"
    assert items[0]["name"] == tool.api_name
    assert items[1] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": [{"type": "input_text", "text": "contents"}],
    }


async def test_responses_argument_delta_is_rendered_before_done() -> None:
    tool = native_tool()
    client = OpenAIResponsesClient(config("openai", "gpt-5"))
    raw = [
        SimpleNamespace(
            type="response.output_item.added",
            output_index=0,
            item=SimpleNamespace(
                type="function_call", call_id="call_1", name=tool.api_name, arguments=""
            ),
        ),
        SimpleNamespace(
            type="response.function_call_arguments.delta",
            output_index=0,
            delta='{"uri":"a<b"}',
        ),
        SimpleNamespace(
            type="response.function_call_arguments.done",
            output_index=0,
            arguments='{"uri":"a<b"}',
        ),
    ]

    translated = [
        event async for event in client._translate_stream(events(raw), "gpt-5", [tool])
    ]
    parsed = parse_tool_call(text(translated).strip())
    assert parsed is not None
    assert parsed.input == {"uri": "a<b"}
