"""Tests for the file-free library API."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest

from chatmd import api
from chatmd.api import ChatSession, assistant_text, complete_turn, run_tool_calls
from chatmd.config.model import ApiConfig, ChatmdConfig
from chatmd.tools.call_parser import (
    CMD_TOOL_CALL_CLOSE_TAG,
    CMD_TOOL_CALL_OPEN_TAG,
    CMD_WAIT_TOOL_RESULT_TAG,
)
from chatmd.types import (
    McpTextContent,
    McpToolExecutionResult,
    MessageParam,
    StreamEvent,
    TextContent,
    TextDelta,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    ToolCall,
    Usage,
    UsageDelta,
)


def tool_call(name: str, value: str = "x") -> str:
    return (
        f"{CMD_TOOL_CALL_OPEN_TAG}\n<cmd:tool_name>{name}</cmd:tool_name>\n"
        f'<cmd:param name="p">{value}</cmd:param>\n{CMD_TOOL_CALL_CLOSE_TAG}'
    )


class FakeClient:
    """Yields scripted events, one script per turn."""

    def __init__(self, *scripts: Sequence[StreamEvent]) -> None:
        self.scripts = list(scripts)
        self.last_usage: Usage | None = None
        self.calls: list[list[MessageParam]] = []

    def stream(
        self,
        messages: list[MessageParam],
        system_prompt: str,
        tools: Sequence[Any],
        *,
        base_dir: Any = None,
    ) -> AsyncIterator[StreamEvent]:
        self.calls.append(list(messages))
        script = self.scripts.pop(0) if self.scripts else []

        async def generate() -> AsyncIterator[StreamEvent]:
            for event in script:
                yield event

        return generate()


class FakePool:
    """Records tool calls and replays canned outcomes."""

    def __init__(self, *outcomes: McpToolExecutionResult | str) -> None:
        self.outcomes = list(outcomes)
        self.called: list[tuple[str, dict[str, str]]] = []

    async def call(
        self, full_name: str, params: Mapping[str, str]
    ) -> McpToolExecutionResult | str:
        self.called.append((full_name, dict(params)))
        if self.outcomes:
            return self.outcomes.pop(0)
        return McpToolExecutionResult(
            server_id="s", tool_name=full_name, content=[McpTextContent(text="ok")]
        )

    def grouped_tools(self) -> dict[str, dict[str, Any]]:
        return {}

    def grouped_resources(self) -> dict[str, dict[str, Any]]:
        return {}


@pytest.fixture
def config() -> ChatmdConfig:
    return ChatmdConfig(
        api_configs={
            "main": ApiConfig(type="anthropic", api_key="k", model_name="claude-opus-5")
        },
        selected_config="main",
    )


@pytest.fixture
def resolved(config: ChatmdConfig) -> Any:
    return config.resolve()


def install(monkeypatch: pytest.MonkeyPatch, client: FakeClient) -> None:
    monkeypatch.setattr(api, "create_client", lambda _config: client)


def user(text: str) -> MessageParam:
    return MessageParam(role="user", content=[TextContent(value=text)])


# --------------------------------------------------------------------------- #
# complete_turn
# --------------------------------------------------------------------------- #


async def test_text_and_usage_are_collected(
    monkeypatch: pytest.MonkeyPatch, resolved: Any
) -> None:
    install(
        monkeypatch,
        FakeClient([TextDelta("Hello "), TextDelta("world"), UsageDelta(Usage(output_tokens=5))]),
    )
    turn = await complete_turn(resolved, [user("hi")], "sys", [])

    assert turn.text == "Hello world"
    assert turn.usage is not None and turn.usage.output_tokens == 5
    assert turn.content == [TextContent(value="Hello world")]


async def test_usage_deltas_are_merged(monkeypatch: pytest.MonkeyPatch, resolved: Any) -> None:
    install(
        monkeypatch,
        FakeClient(
            [
                UsageDelta(Usage(input_tokens=100)),
                TextDelta("x"),
                UsageDelta(Usage(output_tokens=7)),
            ]
        ),
    )
    turn = await complete_turn(resolved, [user("hi")], "sys", [])
    assert turn.usage is not None
    assert (turn.usage.input_tokens, turn.usage.output_tokens) == (100, 7)


async def test_thinking_is_captured_with_its_payload(
    monkeypatch: pytest.MonkeyPatch, resolved: Any
) -> None:
    payload = ThinkingPayload(kind="anthropic_signature", signature="sig")
    install(
        monkeypatch,
        FakeClient(
            [
                ThinkingDelta("weighing"),
                ThinkingPayloadDelta(model="claude-opus-5", payload=payload),
                TextDelta("answer"),
            ]
        ),
    )
    turn = await complete_turn(resolved, [user("hi")], "sys", [])

    assert len(turn.thinking) == 1
    assert turn.thinking[0].value == "weighing"
    assert turn.thinking[0].payload is payload
    # Thinking leads the content, which is what both APIs require on replay.
    assert turn.content[0] is turn.thinking[0]


async def test_reasoning_with_no_payload_survives_as_raw_text(
    monkeypatch: pytest.MonkeyPatch, resolved: Any
) -> None:
    install(monkeypatch, FakeClient([ThinkingDelta("just words"), TextDelta("done")]))
    turn = await complete_turn(resolved, [user("hi")], "sys", [])
    assert [block.value for block in turn.thinking] == ["just words"]
    assert turn.thinking[0].payload is None


async def test_the_end_of_batch_marker_is_stripped(
    monkeypatch: pytest.MonkeyPatch, resolved: Any
) -> None:
    """It is a stream-control signal, never content."""
    install(
        monkeypatch,
        FakeClient([TextDelta(tool_call("read") + "\n" + CMD_WAIT_TOOL_RESULT_TAG + "\n")]),
    )
    turn = await complete_turn(resolved, [user("hi")], "sys", [])

    assert CMD_WAIT_TOOL_RESULT_TAG not in turn.text
    assert turn.ended_on_wait_marker is True
    assert [call.name for call in turn.tool_calls] == ["read"]


async def test_tool_calls_are_parsed_in_order(
    monkeypatch: pytest.MonkeyPatch, resolved: Any
) -> None:
    batch = tool_call("read", "a") + "\n" + tool_call("write", "b")
    install(monkeypatch, FakeClient([TextDelta(batch)]))
    turn = await complete_turn(resolved, [user("hi")], "sys", [])

    assert [call.name for call in turn.tool_calls] == ["read", "write"]
    assert turn.tool_calls[0].params == {"p": "a"}


async def test_a_turn_with_no_tool_calls_reports_none(
    monkeypatch: pytest.MonkeyPatch, resolved: Any
) -> None:
    install(monkeypatch, FakeClient([TextDelta("just prose")]))
    turn = await complete_turn(resolved, [user("hi")], "sys", [])
    assert turn.tool_calls == []
    assert turn.ended_on_wait_marker is False


# --------------------------------------------------------------------------- #
# run_tool_calls
# --------------------------------------------------------------------------- #


async def test_each_call_becomes_its_own_user_message(tmp_path: Any) -> None:
    pool = FakePool(
        McpToolExecutionResult(server_id="s", tool_name="read", content=[McpTextContent(text="A")]),
        McpToolExecutionResult(server_id="s", tool_name="read", content=[McpTextContent(text="B")]),
    )
    calls = [ToolCall(name="s.read", params={"p": "a"}), ToolCall(name="s.read", params={"p": "b"})]

    messages = await run_tool_calls(calls, pool, doc_dir=tmp_path)  # type: ignore[arg-type]

    assert [message.role for message in messages] == ["user", "user"]
    bodies = [message.content[0].raw_text for message in messages]  # type: ignore[union-attr]
    assert "<tool_result>" in bodies[0] and "A" in bodies[0]
    assert "B" in bodies[1]
    assert [name for name, _ in pool.called] == ["s.read", "s.read"]


async def test_a_failing_tool_becomes_a_message_not_an_exception(tmp_path: Any) -> None:
    """The model recovering from a tool error is normal; losing the chat is not."""
    pool = FakePool("Error: Tool \"nope\" not found on any server.")
    messages = await run_tool_calls(
        [ToolCall(name="nope", params={})], pool, doc_dir=tmp_path  # type: ignore[arg-type]
    )
    body = messages[0].content[0].raw_text  # type: ignore[union-attr]
    assert "not found" in body


async def test_no_calls_means_no_messages(tmp_path: Any) -> None:
    assert await run_tool_calls([], FakePool(), doc_dir=tmp_path) == []  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# ChatSession
# --------------------------------------------------------------------------- #


async def test_a_turn_returns_the_assistant_message_and_tool_results(
    monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig, tmp_path: Any
) -> None:
    install(monkeypatch, FakeClient([TextDelta("Reading.\n" + tool_call("s.read"))]))
    session = ChatSession(config, FakePool())  # type: ignore[arg-type]

    added = await session.turn([user("look")], doc_dir=tmp_path)

    assert [message.role for message in added] == ["assistant", "user"]


async def test_run_loops_until_the_model_stops_calling_tools(
    monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig, tmp_path: Any
) -> None:
    client = FakeClient(
        [TextDelta("Step one.\n" + tool_call("s.read"))],
        [TextDelta("Step two.\n" + tool_call("s.read"))],
        [TextDelta("All done.")],
    )
    install(monkeypatch, client)
    session = ChatSession(config, FakePool())  # type: ignore[arg-type]

    history = await session.run([user("go")], doc_dir=tmp_path)

    assert len(client.calls) == 3
    assert [message.role for message in history] == [
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert assistant_text(history) == "All done."


async def test_run_respects_a_round_cap(
    monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig, tmp_path: Any
) -> None:
    client = FakeClient(*[[TextDelta("more\n" + tool_call("s.read"))] for _ in range(5)])
    install(monkeypatch, client)
    session = ChatSession(config, FakePool())  # type: ignore[arg-type]

    await session.run([user("go")], doc_dir=tmp_path, max_rounds=2)

    assert len(client.calls) == 2


async def test_run_does_not_mutate_the_caller_list(
    monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig, tmp_path: Any
) -> None:
    install(monkeypatch, FakeClient([TextDelta("done")]))
    session = ChatSession(config, FakePool())  # type: ignore[arg-type]
    messages = [user("go")]

    await session.run(messages, doc_dir=tmp_path)

    assert len(messages) == 1


def test_native_system_prompt_omits_the_custom_tool_protocol(
    config: ChatmdConfig,
) -> None:
    session = ChatSession(config, FakePool())  # type: ignore[arg-type]
    prompt = session.system_prompt("Be brief.")
    assert "<cmd:tool_call>" not in prompt
    assert "Be brief." in prompt


# --------------------------------------------------------------------------- #
# assistant_text
# --------------------------------------------------------------------------- #


def test_assistant_text_strips_tool_calls_and_the_marker() -> None:
    message = MessageParam(
        role="assistant",
        content=[
            TextContent(
                value=f"Here goes.\n{tool_call('s.read')}\n{CMD_WAIT_TOOL_RESULT_TAG}"
            )
        ],
    )
    assert assistant_text([message]) == "Here goes."


def test_assistant_text_returns_empty_when_there_is_no_assistant_turn() -> None:
    assert assistant_text([user("hi")]) == ""


def test_assistant_text_uses_the_last_assistant_turn() -> None:
    history = [
        MessageParam(role="assistant", content=[TextContent(value="first")]),
        user("then"),
        MessageParam(role="assistant", content=[TextContent(value="second")]),
    ]
    assert assistant_text(history) == "second"
