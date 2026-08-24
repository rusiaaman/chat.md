"""Tests for the file streamer, driven by a scripted fake provider.

These exercise the mechanics the whole agentic loop rests on: append-only
idempotent writes, the section markers, keeping the end-of-batch marker out of the
document, and what gets appended when a turn ends.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

import pytest

from chatmd.engine.streamer import FileStreamer, StreamOutcome
from chatmd.providers.base import MaxTokensError, RetryableError
from chatmd.tools.call_parser import (
    CMD_TOOL_CALL_CLOSE_TAG,
    CMD_TOOL_CALL_OPEN_TAG,
    CMD_WAIT_TOOL_RESULT_TAG,
)
from chatmd.types import (
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


class Pause:
    """Forces a batch boundary, so a test can split content across batches."""

    def __init__(self, seconds: float = 0.05) -> None:
        self.seconds = seconds


Script = Sequence[StreamEvent | Pause] | Exception


class FakeClient:
    """Replays scripted events, one script per attempt so retries are testable."""

    def __init__(self, *scripts: Script) -> None:
        self.scripts = list(scripts)
        self.calls: list[list[MessageParam]] = []
        self.last_usage: Usage | None = None

    def stream(
        self,
        messages: list[MessageParam],
        system_prompt: str,
        *,
        base_dir: Any = None,
    ) -> AsyncIterator[StreamEvent]:
        self.calls.append([MessageParam(m.role, list(m.content)) for m in messages])
        script: Script = self.scripts.pop(0) if self.scripts else []

        async def generate() -> AsyncIterator[StreamEvent]:
            if isinstance(script, Exception):
                raise script
            for item in script:
                if isinstance(item, Pause):
                    await asyncio.sleep(item.seconds)
                    continue
                if isinstance(item, UsageDelta):
                    self.last_usage = item.usage
                yield item

        return generate()


def make_chat(path: Path, body: str = "# %% user\nHi\n\n# %% assistant\n") -> Path:
    path.write_text(body, encoding="utf-8")
    return path


def streamer(path: Path, client: FakeClient) -> FileStreamer:
    return FileStreamer(path, client, batch_interval=0.01)  # type: ignore[arg-type]


def one_message() -> list[MessageParam]:
    return [MessageParam(role="user", content=[TextContent(value="Hi")])]


def tool_call(name: str, param: str = "x") -> str:
    return (
        f"{CMD_TOOL_CALL_OPEN_TAG}\n<cmd:tool_name>{name}</cmd:tool_name>\n"
        f'<cmd:param name="p">{param}</cmd:param>\n{CMD_TOOL_CALL_CLOSE_TAG}'
    )


# --------------------------------------------------------------------------- #
# Ordinary turns
# --------------------------------------------------------------------------- #


async def test_text_is_written_and_a_user_block_is_appended(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("Hello "), TextDelta("world")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.COMPLETED
    text = chat.read_text()
    assert "# %% assistant\nHello world" in text
    # A fresh user block is what lets the human just keep typing.
    assert text.rstrip().endswith("# %% user")


async def test_writes_land_in_the_first_empty_assistant_block(tmp_path: Path) -> None:
    chat = make_chat(
        tmp_path / "a.chat.md",
        "# %% user\nOne\n\n# %% assistant\nEarlier reply\n\n# %% user\nTwo\n\n# %% assistant\n",
    )
    client = FakeClient([TextDelta("Second reply")])

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text()
    assert "Earlier reply" in text
    assert text.index("Earlier reply") < text.index("Second reply")


async def test_usage_is_reported(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("hi"), UsageDelta(Usage(input_tokens=10, output_tokens=2))])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.usage is not None
    assert result.usage.input_tokens == 10


async def test_a_turn_with_no_text_appends_nothing(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    before = chat.read_text()
    client = FakeClient([])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.COMPLETED
    assert chat.read_text() == before


# --------------------------------------------------------------------------- #
# Thinking
# --------------------------------------------------------------------------- #


async def test_thinking_gets_its_own_section_and_a_signature_line(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    payload = ThinkingPayload(kind="anthropic_signature", signature="sig-abc")
    client = FakeClient(
        [
            ThinkingDelta("weighing it up"),
            ThinkingPayloadDelta(model="claude-opus-5", payload=payload),
            TextDelta("The answer."),
        ]
    )

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text()
    assert "## %% thinking" in text
    assert "weighing it up" in text
    assert "## %% text" in text
    assert "claude-opus-5::" in text
    # The payload itself lives beside the chat, not in it.
    stored = json.loads((tmp_path / "cmdassets" / "thinking_map.json").read_text())
    assert any(entry["signature"] == "sig-abc" for entry in stored["entries"].values())


async def test_a_tool_call_written_inside_thinking_is_not_a_tool_call(tmp_path: Path) -> None:
    """Reasoning about a call must never execute one."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient(
        [
            ThinkingDelta("I could write " + tool_call("read_file") + "\n"),
            TextDelta("but I will just answer."),
        ]
    )

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.COMPLETED
    assert "# %% tool_execute" not in chat.read_text()


# --------------------------------------------------------------------------- #
# Tool calls
# --------------------------------------------------------------------------- #


async def test_a_completed_tool_call_appends_a_tool_execute_block(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("Reading.\n" + tool_call("read_file") + "\n")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.TOOL_BATCH_READY
    text = chat.read_text()
    assert text.rstrip().endswith("# %% tool_execute")
    assert CMD_TOOL_CALL_CLOSE_TAG in text


async def test_two_parallel_calls_share_one_tool_execute_block(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    batch = tool_call("read_file", "a.py") + "\n" + tool_call("read_file", "b.py") + "\n"
    client = FakeClient([TextDelta(batch + CMD_WAIT_TOOL_RESULT_TAG + "\n")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.TOOL_BATCH_READY
    assert result.tool_calls_written == 2
    text = chat.read_text()
    assert text.count(CMD_TOOL_CALL_CLOSE_TAG) == 2
    # One block: the driver runs the calls one at a time and adds more itself.
    assert text.count("# %% tool_execute") == 1


async def test_the_end_of_batch_marker_never_reaches_the_document(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    batch = tool_call("read_file") + "\n" + CMD_WAIT_TOOL_RESULT_TAG + "\n"
    client = FakeClient([TextDelta(batch)])

    await streamer(chat, client).run(one_message(), "sys")

    assert CMD_WAIT_TOOL_RESULT_TAG not in chat.read_text()


async def test_a_marker_split_across_batches_never_reaches_the_document(tmp_path: Path) -> None:
    """The tail of a batch that could still become the marker is held back."""
    chat = make_chat(tmp_path / "a.chat.md")
    head, tail = CMD_WAIT_TOOL_RESULT_TAG[:8], CMD_WAIT_TOOL_RESULT_TAG[8:]
    client = FakeClient(
        [
            TextDelta(tool_call("read_file") + "\n" + head),
            Pause(),
            TextDelta(tail + "\n"),
        ]
    )

    result = await streamer(chat, client).run(one_message(), "sys")

    # A real tool call, so the turn ends on the batch and no correction text is
    # appended -- which means nothing else in the file could be quoting the marker.
    assert result.outcome is StreamOutcome.TOOL_BATCH_READY
    text = chat.read_text()
    assert CMD_WAIT_TOOL_RESULT_TAG not in text
    assert head not in text


async def test_held_back_text_that_never_becomes_a_marker_is_still_written(
    tmp_path: Path,
) -> None:
    """Holding text back must delay it, never drop it."""
    chat = make_chat(tmp_path / "a.chat.md")
    head = CMD_WAIT_TOOL_RESULT_TAG[:8]
    client = FakeClient([TextDelta("Done.\n" + head), Pause(), TextDelta("xyz.")])

    await streamer(chat, client).run(one_message(), "sys")

    assert "Done.\n" + head + "xyz." in chat.read_text()


async def test_prose_after_a_tool_call_still_runs_the_batch(tmp_path: Path) -> None:
    """A model that forgets the marker must not hang the loop."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta(tool_call("read_file") + "\nLet me know what that says.")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.TOOL_BATCH_READY
    assert "Let me know what that says." not in chat.read_text()


# --------------------------------------------------------------------------- #
# Corrections
# --------------------------------------------------------------------------- #


async def test_a_stray_marker_appends_a_correction_turn(tmp_path: Path) -> None:
    """Asking to wait for results nothing produced would otherwise hang forever."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("All done.\n" + CMD_WAIT_TOOL_RESULT_TAG + "\n")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.CORRECTION_APPENDED
    text = chat.read_text()
    assert "nothing ran" in text
    # The empty assistant block is the trigger that resumes streaming.
    assert text.rstrip().endswith("# %% assistant")


async def test_a_malformed_tool_call_appends_a_correction_turn(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta(CMD_TOOL_CALL_OPEN_TAG + " oops I forgot the rest")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.CORRECTION_APPENDED
    text = chat.read_text()
    assert "no valid tool call" in text
    assert text.rstrip().endswith("# %% assistant")


async def test_plain_prose_is_not_mistaken_for_a_malformed_call(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("Nothing about tools here.")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.COMPLETED


# --------------------------------------------------------------------------- #
# Idempotency
# --------------------------------------------------------------------------- #


async def test_an_edit_under_a_running_stream_stops_it(tmp_path: Path) -> None:
    """The document is the state, so a stream that lost its place must give up."""
    chat = make_chat(tmp_path / "a.chat.md")

    class Editing(FakeClient):
        def stream(self, messages: Any, system_prompt: Any, *, base_dir: Any = None) -> Any:
            async def generate() -> AsyncIterator[StreamEvent]:
                yield TextDelta("first ")
                await asyncio.sleep(0.05)
                # Someone rewrites the block out from under us.
                chat.write_text("# %% user\nHi\n\n# %% assistant\nrewritten\n")
                await asyncio.sleep(0.05)
                yield TextDelta("second")

            return generate()

    result = await streamer(chat, Editing()).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.ABORTED
    text = chat.read_text()
    assert "rewritten" in text
    assert "second" not in text


async def test_cancelling_stops_writing_but_keeps_what_landed(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    engine = streamer(chat, FakeClient([TextDelta("kept "), Pause(), TextDelta("dropped")]))

    async def cancel_soon() -> None:
        await asyncio.sleep(0.03)
        engine.cancel()

    _, result = await asyncio.gather(cancel_soon(), engine.run(one_message(), "sys"))

    assert result.outcome is StreamOutcome.ABORTED
    assert "kept" in chat.read_text()
    assert "dropped" not in chat.read_text()


# --------------------------------------------------------------------------- #
# Retries
# --------------------------------------------------------------------------- #


async def test_the_output_limit_restarts_the_turn(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient(MaxTokensError("limit"), [TextDelta("continued to the end.")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.COMPLETED
    assert "continued to the end." in chat.read_text()
    assert len(client.calls) == 2


async def test_the_restart_carries_the_partial_turn_into_context(tmp_path: Path) -> None:
    """Otherwise the model would start its answer over instead of continuing it."""
    chat = make_chat(tmp_path / "a.chat.md")

    class Truncating(FakeClient):
        def stream(self, messages: Any, system_prompt: Any, *, base_dir: Any = None) -> Any:
            self.calls.append([MessageParam(m.role, list(m.content)) for m in messages])
            attempt = len(self.calls)

            async def generate() -> AsyncIterator[StreamEvent]:
                if attempt == 1:
                    yield TextDelta("As I was saying")
                    raise MaxTokensError("limit")
                yield TextDelta(" — continued.")

            return generate()

    client = Truncating()
    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.COMPLETED
    assert len(client.calls) == 2
    replayed = client.calls[1][-1]
    assert replayed.role == "assistant"
    assert any(
        isinstance(block, TextContent) and "As I was saying" in block.value
        for block in replayed.content
    )
    # Both halves live in the same assistant block.
    assert "As I was saying — continued." in chat.read_text()


async def test_a_transport_error_is_retried(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient(RetryableError("503"), [TextDelta("worked on retry")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.COMPLETED
    assert "worked on retry" in chat.read_text()
    assert len(client.calls) == 2


async def test_repeated_transport_errors_give_up(tmp_path: Path) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient(*[RetryableError("503") for _ in range(6)])
    engine = FileStreamer(chat, client, batch_interval=0.01)  # type: ignore[arg-type]
    engine.cancel()  # a cancelled streamer gives up instead of sleeping out the backoff

    result = await engine.run(one_message(), "sys")

    assert result.outcome is StreamOutcome.FAILED
    assert result.error is not None


@pytest.mark.parametrize("body", ["# %% user\nHi\n", ""])
async def test_a_document_with_no_empty_assistant_block_writes_nothing(
    tmp_path: Path, body: str
) -> None:
    chat = make_chat(tmp_path / "a.chat.md", body)
    client = FakeClient([TextDelta("nowhere to go")])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.ABORTED
    assert "nowhere to go" not in chat.read_text()
