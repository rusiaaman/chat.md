"""End-to-end: a real chat file driven through a full agentic loop.

Everything here is the real engine — parser, streamer, driver, locks, assets — with
only the LLM and the MCP servers faked. It is the test that proves the pieces fit:
a document goes in, and a finished conversation comes out with the tool call
written, executed, its result recorded, and the follow-up turn streamed.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from chatmd.config.model import ApiConfig, ChatmdConfig
from chatmd.engine import driver as driver_module
from chatmd.engine.driver import ChatDriver, StepAction
from chatmd.engine.streamer import StreamOutcome
from chatmd.parser.document import parse_document
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
    Usage,
    UsageDelta,
)


def tool_call(name: str, value: str) -> str:
    return (
        f"{CMD_TOOL_CALL_OPEN_TAG}\n<cmd:tool_name>{name}</cmd:tool_name>\n"
        f'<cmd:param name="path">{value}</cmd:param>\n{CMD_TOOL_CALL_CLOSE_TAG}'
    )


class ScriptedClient:
    """One scripted turn per call, so a whole conversation can be laid out."""

    def __init__(self, *turns: Sequence[StreamEvent]) -> None:
        self.turns = list(turns)
        self.prompts: list[str] = []
        self.histories: list[list[MessageParam]] = []
        self.last_usage: Usage | None = None

    def stream(
        self, messages: list[MessageParam], system_prompt: str, *, base_dir: Any = None
    ) -> AsyncIterator[StreamEvent]:
        self.prompts.append(system_prompt)
        self.histories.append(list(messages))
        if not self.turns:
            # Loudly, not silently: an unscripted turn means the test expected the
            # loop to have stopped, and yielding nothing would hang it instead.
            raise AssertionError(f"unscripted turn #{len(self.histories)}")
        events = self.turns.pop(0)

        async def generate() -> AsyncIterator[StreamEvent]:
            for event in events:
                yield event

        return generate()


class ScriptedPool:
    def __init__(self, *results: McpToolExecutionResult | str) -> None:
        self.results = list(results)
        self.called: list[tuple[str, dict[str, str]]] = []

    async def call(
        self, full_name: str, params: Mapping[str, str]
    ) -> McpToolExecutionResult | str:
        self.called.append((full_name, dict(params)))
        if self.results:
            return self.results.pop(0)
        return McpToolExecutionResult(
            server_id="fs", tool_name=full_name, content=[McpTextContent(text="(no result)")]
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


def install(monkeypatch: pytest.MonkeyPatch, client: ScriptedClient) -> None:
    monkeypatch.setattr(driver_module, "create_client", lambda _resolved: client)


async def test_a_tool_using_conversation_runs_to_completion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig
) -> None:
    chat = tmp_path / "session.chat.md"
    chat.write_text(
        "# %% system\nBe brief.\n\n# %% user\nWhat is in config.py?\n\n# %% assistant\n",
        encoding="utf-8",
    )

    client = ScriptedClient(
        # Turn one: think, say something, then call a tool and end the batch.
        [
            ThinkingDelta("I should read the file."),
            ThinkingPayloadDelta(
                model="claude-opus-5",
                payload=ThinkingPayload(kind="anthropic_signature", signature="sig-1"),
            ),
            TextDelta("Let me look.\n"),
            TextDelta(tool_call("fs.read_file", "config.py") + "\n"),
            TextDelta(CMD_WAIT_TOOL_RESULT_TAG + "\n"),
            UsageDelta(Usage(input_tokens=500, output_tokens=40)),
        ],
        # Turn two: answer using the result.
        [
            TextDelta("It holds the database settings."),
            UsageDelta(Usage(input_tokens=800, output_tokens=12)),
        ],
    )
    install(monkeypatch, client)
    pool = ScriptedPool(
        McpToolExecutionResult(
            server_id="fs",
            tool_name="read_file",
            content=[McpTextContent(text="DB_HOST = 'localhost'")],
        )
    )

    driver = ChatDriver(config, pool)  # type: ignore[arg-type]
    results = await driver.run(chat)

    assert [result.action for result in results] == [
        StepAction.STREAMED,
        StepAction.EXECUTED_TOOL,
        StepAction.STREAMED,
        StepAction.IDLE,
    ]
    assert results[0].outcome is StreamOutcome.TOOL_BATCH_READY
    assert results[2].outcome is StreamOutcome.COMPLETED
    assert pool.called == [("fs.read_file", {"path": "config.py"})]

    text = chat.read_text()

    # The reasoning is recorded, with its payload kept beside the chat rather than
    # in it, and the control marker never reaches the document.
    assert "## %% thinking" in text
    assert "claude-opus-5::" in text
    assert CMD_WAIT_TOOL_RESULT_TAG not in text
    assert (tmp_path / "cmdassets" / "thinking_map.json").exists()

    # The call, its result, and the follow-up answer are all in the document.
    assert CMD_TOOL_CALL_CLOSE_TAG in text
    assert "<tool_result>" in text
    assert "DB_HOST = 'localhost'" in text
    assert "It holds the database settings." in text
    # Ends ready for the human to type again.
    assert text.rstrip().endswith("# %% user")

    # The system prompt the model saw carried the file's own system block.
    assert "Be brief." in client.prompts[0]

    # The second turn replayed the first, marker restored, plus the tool result.
    replayed = client.histories[1]
    assert [message.role for message in replayed] == ["user", "assistant", "user"]
    assistant_text = "".join(
        block.value for block in replayed[1].content if isinstance(block, TextContent)
    )
    assert CMD_WAIT_TOOL_RESULT_TAG in assistant_text
    assert "DB_HOST" in "".join(
        block.value for block in replayed[2].content if isinstance(block, TextContent)
    )


async def test_the_finished_document_parses_back_to_the_same_conversation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig
) -> None:
    """The document is the record, so it has to read back as what happened."""
    chat = tmp_path / "session.chat.md"
    chat.write_text("# %% user\nhi\n\n# %% assistant\n", encoding="utf-8")

    install(
        monkeypatch,
        ScriptedClient(
            [TextDelta("Reading.\n" + tool_call("fs.read_file", "a.py") + "\n")],
            [TextDelta("Done.")],
        ),
    )
    pool = ScriptedPool(
        McpToolExecutionResult(
            server_id="fs", tool_name="read_file", content=[McpTextContent(text="contents")]
        )
    )

    await ChatDriver(config, pool).run(chat)  # type: ignore[arg-type]

    parsed = parse_document(chat.read_text(), tmp_path)
    assert [message.role for message in parsed.messages] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]


async def test_a_long_tool_result_is_spilled_to_a_file_and_linked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig
) -> None:
    """A huge result must not drown the document, but must still reach the model."""
    chat = tmp_path / "session.chat.md"
    chat.write_text("# %% user\nhi\n\n# %% assistant\n", encoding="utf-8")

    install(
        monkeypatch,
        ScriptedClient(
            [TextDelta(tool_call("fs.read_file", "big.py") + "\n")],
            [TextDelta("Read it.")],
        ),
    )
    body = "\n".join(f"line {index}" for index in range(200))
    pool = ScriptedPool(
        McpToolExecutionResult(
            server_id="fs", tool_name="read_file", content=[McpTextContent(text=body)]
        )
    )

    await ChatDriver(config, pool).run(chat)  # type: ignore[arg-type]

    text = chat.read_text()
    assert "[Tool Result](" in text
    assert "line 199" not in text  # the bulk lives in the asset file
    spilled = list((tmp_path / "cmdassets").glob("tool-result-*"))
    assert spilled and "line 199" in spilled[0].read_text()

    # And the parser reads it back in, so the model still sees the whole thing.
    parsed = parse_document(text, tmp_path)
    tool_message = parsed.messages[2]
    assert "line 199" in "".join(
        block.value for block in tool_message.content if isinstance(block, TextContent)
    )


async def test_two_parallel_calls_are_executed_one_at_a_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig
) -> None:
    chat = tmp_path / "session.chat.md"
    chat.write_text("# %% user\nhi\n\n# %% assistant\n", encoding="utf-8")

    batch = tool_call("fs.read_file", "a.py") + "\n" + tool_call("fs.read_file", "b.py") + "\n"
    install(
        monkeypatch,
        ScriptedClient(
            [TextDelta(batch + CMD_WAIT_TOOL_RESULT_TAG + "\n")],
            [TextDelta("Both read.")],
        ),
    )
    pool = ScriptedPool(
        McpToolExecutionResult(
            server_id="fs", tool_name="read_file", content=[McpTextContent(text="AAA")]
        ),
        McpToolExecutionResult(
            server_id="fs", tool_name="read_file", content=[McpTextContent(text="BBB")]
        ),
    )

    results = await ChatDriver(config, pool).run(chat)  # type: ignore[arg-type]

    executed = [result for result in results if result.action is StepAction.EXECUTED_TOOL]
    assert len(executed) == 2
    assert [params["path"] for _, params in pool.called] == ["a.py", "b.py"]

    text = chat.read_text()
    assert text.count("<tool_result>") == 2
    assert "AAA" in text and "BBB" in text
    assert "Both read." in text


async def test_a_locked_file_is_left_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig
) -> None:
    """Whoever holds the lock owns the document; the driver must not race them."""
    from chatmd.engine.locks import chat_file_lock

    chat = tmp_path / "session.chat.md"
    original = "# %% user\nhi\n\n# %% assistant\n"
    chat.write_text(original, encoding="utf-8")

    install(monkeypatch, ScriptedClient([TextDelta("should never be written")]))

    holder = chat_file_lock(chat, owner="vscode")
    holder.acquire()
    try:
        results = await ChatDriver(config, ScriptedPool()).run(chat)  # type: ignore[arg-type]
    finally:
        holder.release()

    assert [result.action for result in results] == [StepAction.LOCKED]
    assert chat.read_text() == original


async def test_a_tool_result_containing_a_whole_chat_file_does_not_split_the_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig
) -> None:
    """One chat reading another is the case marker escaping exists for.

    Written raw, the other file's markers split this document: the tool_result
    wrapper loses its other half and turns that never happened appear in the
    history.
    """
    chat = tmp_path / "session.chat.md"
    chat.write_text("# %% user\nRead notes.chat.md\n\n# %% assistant\n", encoding="utf-8")

    other = "# %% user\nWhat is 2+2?\n\n# %% assistant\n4\n\n## %% thinking\nhmm\n"
    install(
        monkeypatch,
        ScriptedClient(
            [TextDelta(tool_call("fs.read_file", "notes.chat.md") + "\n")],
            [TextDelta("It asks about arithmetic.")],
        ),
    )
    pool = ScriptedPool(
        McpToolExecutionResult(
            server_id="fs", tool_name="read_file", content=[McpTextContent(text=other)]
        )
    )

    await ChatDriver(config, pool).run(chat)  # type: ignore[arg-type]

    text = chat.read_text()
    parsed = parse_document(text, tmp_path)

    # Four turns, not the six an unescaped result would produce.
    assert [message.role for message in parsed.messages] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    # The other file survived verbatim, escaping removed, inside one tool result.
    tool_message = "".join(
        block.value for block in parsed.messages[2].content if isinstance(block, TextContent)
    )
    assert other in tool_message
    assert tool_message.count("<tool_result>") == 1
    # The document itself carries the escaped form, so it stays one document.
    assert "# %%% user" in text
    assert "## %%% thinking" in text


@pytest.mark.xfail(
    strict=True,
    reason="the streamer does not escape yet, so the call's own markers split the "
    "document before it can be executed",
)
async def test_a_tool_call_writing_a_chat_file_gets_its_markers_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config: ChatmdConfig
) -> None:
    """The tool must receive what the model wrote, not the escaped form."""
    chat = tmp_path / "session.chat.md"
    chat.write_text("# %% user\nMake me a chat\n\n# %% assistant\n", encoding="utf-8")

    wanted = "# %% user\nhello\n\n# %% assistant\n"
    call = (
        f"{CMD_TOOL_CALL_OPEN_TAG}\n<cmd:tool_name>fs.write_file</cmd:tool_name>\n"
        f'<cmd:param name="content">{wanted}</cmd:param>\n{CMD_TOOL_CALL_CLOSE_TAG}'
    )
    install(
        monkeypatch,
        ScriptedClient([TextDelta(call + "\n")], [TextDelta("Written.")]),
    )
    pool = ScriptedPool(
        McpToolExecutionResult(
            server_id="fs", tool_name="write_file", content=[McpTextContent(text="ok")]
        )
    )

    await ChatDriver(config, pool).run(chat)  # type: ignore[arg-type]

    assert len(pool.called) == 1
    _name, params = pool.called[0]
    assert params["content"] == wanted
