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
from chatmd.markers import unescape_markers
from chatmd.parser.blocks import split_blocks
from chatmd.providers.base import MaxTokensError, RetryableError
from chatmd.render import strip_thinking_sections
from chatmd.tools.call_parser import (
    CMD_TOOL_CALL_CLOSE_TAG,
    CMD_TOOL_CALL_OPEN_TAG,
    CMD_WAIT_TOOL_RESULT_TAG,
    find_all_tool_calls,
    parse_tool_call,
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


# --------------------------------------------------------------------------- #
# Marker escaping
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("split_at", ["same_batch", "after_first", "partial_marker", "after_marker"])
async def test_buffered_tool_calls_escape_markers_once(tmp_path: Path, split_at: str) -> None:
    chat = make_chat(tmp_path / "a.chat.md")
    wanted = (
        "# %% user\nhello\n# %% assistant\n## %% thinking\nreason\n"
        "## %% text\nanswer\n# %%% user\n# %% settings\nconfig"
    )
    first = tool_call("first", "one")
    second = tool_call("second", wanted)
    third = tool_call("third", wanted)
    content = first + "\n" + second + "\n" + third + CMD_WAIT_TOOL_RESULT_TAG
    offsets = {
        "same_batch": len(content),
        "after_first": len(first),
        "partial_marker": content.index("\n# %% assistant") + len("\n# %% ass"),
        "after_marker": content.index("\n## %% thinking") + 1,
    }
    offset = offsets[split_at]
    client = FakeClient([TextDelta(content[:offset]), Pause(), TextDelta(content[offset:])])

    result = await streamer(chat, client).run(one_message(), "sys")

    assert result.outcome is StreamOutcome.TOOL_BATCH_READY
    blocks = split_blocks(chat.read_text())
    assert [block.type for block in blocks] == ["user", "assistant", "tool_execute"]
    calls = find_all_tool_calls(unescape_markers(strip_thinking_sections(blocks[1].raw_content)))
    assert len(calls) == 3
    parsed = [parse_tool_call(call) for call in calls]
    assert all(call is not None for call in parsed)
    assert [call.params["p"] for call in parsed if call is not None] == ["one", wanted, wanted]


async def test_a_marker_line_in_assistant_text_is_escaped(tmp_path: Path) -> None:
    """Written raw it would split the document the model is writing into."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("Here is a chat file:\n# %% user\nhello\n")])

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text()
    assert "# %%% user" in text
    # Still exactly the blocks we started with, plus the appended user block.
    assert text.count("\n# %% user") == 1


async def test_a_marker_split_across_batches_is_still_escaped(tmp_path: Path) -> None:
    """A marker is only decidable at end of line, so the partial line waits."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("intro\n# %% us"), Pause(), TextDelta("er\nbody\n")])

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text()
    assert "# %%% user" in text
    assert "\n# %% user\nbody" not in text


async def test_a_partial_line_that_never_becomes_a_marker_is_written_intact(
    tmp_path: Path,
) -> None:
    """Holding a line back must delay it, never drop or mangle it."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient([TextDelta("a\n# %% us"), Pause(), TextDelta("ername is bob\n")])

    await streamer(chat, client).run(one_message(), "sys")

    assert "# %% username is bob" in chat.read_text()


async def test_a_markdown_heading_is_not_held_back(tmp_path: Path) -> None:
    """Headings are common in answers; delaying every one would be visible."""
    chat = make_chat(tmp_path / "a.chat.md")
    engine = streamer(chat, FakeClient([TextDelta("# Introduction"), Pause(), TextDelta("\nbody")]))

    async def read_midway() -> str:
        await asyncio.sleep(0.03)
        return chat.read_text()

    midway, _ = await asyncio.gather(read_midway(), engine.run(one_message(), "sys"))

    assert "# Introduction" in midway
    assert "# Introduction\nbody" in chat.read_text()


async def test_a_section_marker_in_thinking_is_escaped(tmp_path: Path) -> None:
    """Reasoning about a chat file must not split the assistant block."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient(
        [
            ThinkingDelta("the file says\n## %% text\nand more\n"),
            TextDelta("Answer."),
        ]
    )

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text()
    assert "## %%% text" in text
    # One real thinking marker and one real text marker, both the streamer's own.
    assert text.count("\n## %% thinking") == 1
    assert text.count("\n## %% text") == 1


async def test_escaped_content_round_trips_back_through_the_parser(tmp_path: Path) -> None:
    from chatmd.parser.document import parse_document

    chat = make_chat(tmp_path / "a.chat.md")
    written = "Look:\n# %% user\nhi\n\n# %% assistant\nthere\n"
    await streamer(chat, FakeClient([TextDelta(written)])).run(one_message(), "sys")

    parsed = parse_document(chat.read_text(), tmp_path)
    assistant = next(m for m in parsed.messages if m.role == "assistant")
    body = "".join(b.value for b in assistant.content if isinstance(b, TextContent))
    assert body == written.strip()


async def test_a_marker_arriving_mid_line_is_not_escaped(tmp_path: Path) -> None:
    """The reported bug: a batch starting at `# %% user` inside a tool call.

    Escaped there, the extra percent sign would never come off — unescaping works
    on whole lines — and the subagent file would be written with a marker that
    never triggers.
    """
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient(
        [
            TextDelta('Writing it:\n<cmd:param name="content">'),
            Pause(),
            TextDelta("# %% user\nDo the thing\n"),
        ]
    )

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text()
    assert '<cmd:param name="content"># %% user' in text
    assert "# %%% user" not in text


async def test_a_marker_on_its_own_line_in_a_later_batch_is_still_escaped(
    tmp_path: Path,
) -> None:
    """The continuation rule applies to the first line only."""
    chat = make_chat(tmp_path / "a.chat.md")
    client = FakeClient(
        [TextDelta("intro: "), Pause(), TextDelta("still here\n# %% user\nbody\n")]
    )

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text()
    assert "intro: still here" in text
    assert "# %%% user" in text


# --------------------------------------------------------------------------- #
# Appending without rewriting the document
#
# Streaming inserts at the end of the assistant block, which is normally the end
# of the file, so the naive read-slice-rewrite produced a byte-identical copy of
# the whole document on every token batch -- hundreds of megabytes of writes over
# one turn on a long chat. The fast path must be indistinguishable in its result.
# --------------------------------------------------------------------------- #


async def test_appending_at_eof_leaves_the_rest_of_the_document_untouched(
    tmp_path: Path,
) -> None:
    chat = make_chat(
        tmp_path / "a.chat.md",
        "# %% user\nOne\n\n# %% assistant\nEarlier reply\n\n# %% user\nTwo\n\n# %% assistant\n",
    )
    prefix = chat.read_text(encoding="utf-8")
    client = FakeClient([TextDelta("Second "), TextDelta("reply")])

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text(encoding="utf-8")
    assert text.startswith(prefix), "everything before the insertion point must be byte-identical"
    assert "Second reply" in text


async def test_a_trailing_blank_line_after_the_marker_still_streams(tmp_path: Path) -> None:
    """The insertion point is not EOF here, so the slower rewrite path has to run.

    An empty assistant block is empty up to the next assistant marker, so trailing
    whitespace after the marker is the ordinary way content ends up sitting after
    the insertion point -- a file simply saved with a trailing newline.
    """
    chat = make_chat(tmp_path / "a.chat.md", "# %% user\nHi\n\n# %% assistant\n\n")
    client = FakeClient([TextDelta("Reply "), TextDelta("here")])

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text(encoding="utf-8")
    assert "# %% assistant\nReply here" in text


async def test_multibyte_text_appends_at_the_right_offset(tmp_path: Path) -> None:
    """Offsets are in characters; appending must not confuse them with bytes."""
    chat = make_chat(tmp_path / "a.chat.md", "# %% user\nHi ünïcodé ✨\n\n# %% assistant\n")
    client = FakeClient([TextDelta("héllo "), TextDelta("wörld ✨"), TextDelta(" 日本語")])

    await streamer(chat, client).run(one_message(), "sys")

    text = chat.read_text(encoding="utf-8")
    assert "# %% assistant\nhéllo wörld ✨ 日本語" in text
    assert "Hi ünïcodé ✨" in text
