"""Tests for the stateless context sent to subscription-backed agent SDKs."""

from __future__ import annotations

from pathlib import Path

from chatmd.providers.agent_context import build_agent_prompt
from chatmd.providers.native_tools import render_tool_call
from chatmd.types import (
    MessageParam,
    TextContent,
    ThinkingContent,
    ToolResultContent,
    ToolUseContent,
)


def tool_pair(index: int) -> tuple[ToolUseContent, ToolResultContent]:
    call_id = f"call-{index}"
    name = f"server.tool_{index}"
    arguments = {"value": f"argument-{index}-" + "x" * 120}
    call = ToolUseContent(
        id=call_id,
        name=name,
        input=arguments,
        raw_xml=render_tool_call(call_id, name, arguments),
        server_tool=index % 2 == 0,
    )
    result = ToolResultContent(
        tool_use_id=call_id,
        name=name,
        content=[TextContent(value=f"result-{index}")],
        raw_text=f"<tool_result>\nresult-{index}-" + "y" * 120 + "\n</tool_result>",
        is_error=False,
        server_tool=index % 2 == 0,
    )
    return call, result


def test_agent_prompt_prunes_reasoning_and_keeps_searchable_tool_history(
    tmp_path: Path,
) -> None:
    messages = [
        MessageParam(role="user", content=[TextContent(value="Please inspect it.")]),
        MessageParam(
            role="assistant",
            content=[
                ThinkingContent(value="private reasoning"),
                TextContent(value="I will inspect it."),
            ],
        ),
    ]
    for index in range(1, 7):
        call, result = tool_pair(index)
        messages.extend(
            [
                MessageParam(role="assistant", content=[call]),
                MessageParam(role="user", content=[result]),
            ]
        )

    prompt = build_agent_prompt(
        messages,
        tmp_path / "task.chat.md",
        "/config/settings.json",
        "Follow the project conventions.",
        "Subagent instructions.",
    )

    assert f"Current chat file: {tmp_path / 'task.chat.md'}" in prompt
    assert "Please inspect it." in prompt
    assert "I will inspect it." in prompt
    assert "private reasoning" not in prompt
    assert "1. server.tool_1" in prompt
    assert "6. server.tool_6" in prompt
    assert "Tool #1:" not in prompt
    assert "Tool #2: server.tool_2" in prompt
    assert "Tool #6: server.tool_6" in prompt
    assert "argument-1-" + "x" * 100 not in prompt
    assert "## %% server_tool" in prompt
    assert "Provider profiles are named entries" in prompt
