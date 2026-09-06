"""Streams one assistant turn straight into a ``.chat.md`` file.

Port of ``src/streamer.ts``. Writing is append-only and idempotent: before every
write the streamer checks that the text it previously wrote is still exactly what
sits at the start of the target block, and gives up permanently if it is not. The
document is the only state, so a chat that was edited underneath a running stream
ends the stream rather than corrupting the file.

Where the extension applies a ``WorkspaceEdit`` to an in-memory buffer, this reads
and rewrites the file in place. In place rather than atomic rename on purpose: an
editor watching the file would lose track of it if the inode were swapped.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from ..assets import assets_dir
from ..markers import could_become_marker_line
from ..parser.assistant_content import parse_assistant_content
from ..parser.blocks import find_all_assistant_blocks
from ..providers.base import LlmClient, MaxTokensError, RetryableError
from ..render import (
    SectionState,
    block_marker_prefix,
    format_signature_line,
    render_stream_events,
    strip_thinking_sections,
)
from ..thinking_map import put_thinking_entry
from ..tools.call_parser import (
    CMD_TOOL_CALL_OPEN_TAG,
    CMD_WAIT_TOOL_RESULT_TAG,
    check_for_completed_tool_call,
    find_wait_marker,
    wait_marker_prefix_length,
)
from ..types import (
    MessageParam,
    StreamEvent,
    TextDelta,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    Usage,
)
from .stream_batching import DEFAULT_BATCH_INTERVAL, batched_events

logger = logging.getLogger(__name__)

#: Any use of the qualified namespace, including a malformed one. Split so this
#: file's own text can never be mistaken for a tool call.
CMD_NAMESPACE_PREFIX = "<" + "cmd:"

MAX_SERVER_RETRIES = 5
MAX_TOKEN_RETRIES = 10
MAX_BACKOFF_SECONDS = 32.0


class StreamOutcome(StrEnum):
    """How a turn ended, which is what the driver needs to decide what happens next."""

    #: Natural finish; a fresh user block was appended.
    COMPLETED = "completed"
    #: One or more tool calls were written and a tool_execute block appended.
    TOOL_BATCH_READY = "tool_batch_ready"
    #: A correction turn plus an empty assistant block were appended, so the
    #: document itself will trigger the retry.
    CORRECTION_APPENDED = "correction_appended"
    #: The document no longer matched what had been written, or the stream was
    #: cancelled. Nothing further should be attempted for this trigger.
    ABORTED = "aborted"
    #: The provider failed in a way retries could not fix.
    FAILED = "failed"


@dataclass
class StreamResult:
    outcome: StreamOutcome
    usage: Usage | None = None
    characters_written: int = 0
    tool_calls_written: int = 0
    error: str | None = None


@dataclass
class StreamerState:
    """What has been written into the assistant block, and where the sections are."""

    tokens: list[str] = field(default_factory=list)
    section: SectionState = field(default_factory=SectionState)
    #: Trailing text withheld because it could still grow into the end-of-batch
    #: marker, or into a block marker line. Prepended to the next batch instead of
    #: being written, so neither ever reaches the document split in half.
    pending_text: str = ""
    #: Whether the withheld text was reasoning rather than assistant text, so it
    #: goes back into the section it came from.
    pending_is_thinking: bool = False
    is_handling_tool_call: bool = False
    active: bool = True

    @property
    def written(self) -> str:
        return "".join(self.tokens)


@dataclass
class _BufferResult:
    remaining: str
    stop: bool = False
    failed: bool = False
    wait_marker: bool = False


class FileStreamer:
    """Drives one assistant turn for one chat file."""

    def __init__(
        self,
        path: str | Path,
        client: LlmClient,
        *,
        assets_path: str = "cmdassets",
        batch_interval: float = DEFAULT_BATCH_INTERVAL,
    ) -> None:
        self.path = Path(path)
        self.client = client
        self.assets_path = assets_path
        self.batch_interval = batch_interval
        self.state = StreamerState()

    # -- public ------------------------------------------------------------ #

    def cancel(self) -> None:
        """Stop at the next batch boundary, leaving what is already written."""
        self.state.active = False

    async def run(self, messages: list[MessageParam], system_prompt: str) -> StreamResult:
        """Stream a turn, retrying transport failures and output-limit truncation."""
        current = list(messages)
        server_attempt = 0
        token_attempt = 0

        while True:
            try:
                return await self._stream_once(current, system_prompt)
            except MaxTokensError as error:
                token_attempt += 1
                if token_attempt >= MAX_TOKEN_RETRIES or not self.state.active:
                    logger.error("Giving up after %d output-limit retries", token_attempt)
                    return StreamResult(StreamOutcome.FAILED, error=str(error))
                # Continue the same assistant block: the partial text becomes part
                # of the context so the model picks up where it stopped.
                current = self._with_partial_assistant(current)
                logger.info(
                    "Output limit reached, restarting stream (%d/%d)",
                    token_attempt,
                    MAX_TOKEN_RETRIES,
                )
            except RetryableError as error:
                server_attempt += 1
                if server_attempt >= MAX_SERVER_RETRIES or not self.state.active:
                    logger.error("Giving up after %d transport retries", server_attempt)
                    return StreamResult(StreamOutcome.FAILED, error=str(error))
                backoff = min(2.0**server_attempt, MAX_BACKOFF_SECONDS)
                logger.warning(
                    "Transport error (%s), retrying in %.0fs (%d/%d)",
                    error,
                    backoff,
                    server_attempt,
                    MAX_SERVER_RETRIES,
                )
                await asyncio.sleep(backoff)

    # -- the turn ---------------------------------------------------------- #

    async def _stream_once(
        self, messages: list[MessageParam], system_prompt: str
    ) -> StreamResult:
        buffering = False
        buffer_text = ""
        update_failed = False
        cancelled = False
        stray_wait_marker = False
        tool_calls_written = 0

        stream = self.client.stream(messages, system_prompt, base_dir=self.path.parent)

        async for events in batched_events(stream, self.batch_interval):
            if not self.state.active:
                cancelled = True
                break

            if buffering:
                # A tool call already completed this turn. Everything after it is
                # buffered and classified, never streamed straight to the file.
                # Thinking that arrives now belongs to no section and is dropped.
                texts = [event.text for event in events if isinstance(event, TextDelta)]
                if not texts:
                    continue
                buffer_text += "".join(texts)
                result = await self._process_buffered_tool_calls(buffer_text)
                buffer_text = result.remaining
                tool_calls_written = self._count_tool_calls()
                if result.stop:
                    update_failed = result.failed
                    break
                continue

            batch = self._hold_back_marker_line(
                self._coalesce(self._with_pending_text(events))
            )
            rendered = render_stream_events(
                batch, self.state.written, self.state.section, self._record_payload
            )
            if not rendered:
                continue

            current = self.state.written + rendered
            scan_start = self.state.section.scan_offset
            scan_end = (
                len(current)
                if self.state.section.text_section_end is None
                else self.state.section.text_section_end
            )
            completed = (
                check_for_completed_tool_call(current[scan_start:scan_end])
                if scan_end > scan_start
                else None
            )

            if completed is not None:
                self.state.is_handling_tool_call = True
                end_index = scan_start + completed.end_index
                logger.debug("Tool call %r complete at %d", completed.tool_name, end_index)

                # Anything already written past the call is dropped from the token
                # history so the tool_execute block is spliced right after the call.
                if len(self.state.written) > end_index:
                    self.state.tokens = [self.state.written[:end_index]]

                keep = max(0, end_index - len(self.state.written))
                to_write = rendered[:keep]
                if to_write and not self._append(to_write):
                    update_failed = True
                    break

                buffering = True
                buffer_text = current[end_index:]
                result = await self._process_buffered_tool_calls(buffer_text)
                buffer_text = result.remaining
                tool_calls_written = self._count_tool_calls()
                if result.stop:
                    update_failed = result.failed
                    break
                continue

            to_write, stray_wait_marker = self._trim_wait_marker(
                rendered, current, scan_start, scan_end
            )
            if to_write and not self._append(to_write):
                update_failed = True
                break
            if stray_wait_marker:
                # The model asked to wait for results it never requested. Nothing
                # ran, so the turn has to end and be corrected.
                break

        healthy = self.state.active and not update_failed and not cancelled

        # Held-back text the stream never completed into a marker is ordinary
        # assistant text, so write it rather than dropping the end of the turn.
        if healthy and self.state.pending_text:
            flushed = self.state.pending_text
            was_thinking = self.state.pending_is_thinking
            self.state.pending_text = ""
            self.state.pending_is_thinking = False
            final: StreamEvent = (
                ThinkingDelta(flushed) if was_thinking else TextDelta(flushed)
            )
            rendered = render_stream_events(
                [final], self.state.written, self.state.section, self._record_payload
            )
            if rendered and not self._append(rendered):
                update_failed = True
                healthy = False

        usage = getattr(self.client, "last_usage", None)
        written = len(self.state.written)

        if not healthy:
            outcome = StreamOutcome.ABORTED
            logger.info("Turn ended without completing (cancelled=%s)", cancelled)
            return StreamResult(outcome, usage=usage, characters_written=written)

        if buffering:
            self._insert_tool_execute_block()
            return StreamResult(
                StreamOutcome.TOOL_BATCH_READY,
                usage=usage,
                characters_written=written,
                tool_calls_written=tool_calls_written or self._count_tool_calls(),
            )

        if stray_wait_marker:
            self._append_stray_wait_marker_correction()
            return StreamResult(
                StreamOutcome.CORRECTION_APPENDED, usage=usage, characters_written=written
            )

        if written and CMD_NAMESPACE_PREFIX in strip_thinking_sections(self.state.written):
            # The turn mentioned the namespace but produced no complete call, so it
            # tried to call a tool and got the format wrong. Correct it rather than
            # leaving the user with a turn that looks like it did something.
            self._append_malformed_tool_correction()
            return StreamResult(
                StreamOutcome.CORRECTION_APPENDED, usage=usage, characters_written=written
            )

        if written:
            self._append_new_user_block()
        return StreamResult(StreamOutcome.COMPLETED, usage=usage, characters_written=written)

    # -- buffering --------------------------------------------------------- #

    def _classify_buffer(self, buffer: str) -> str:
        """What buffered text following a tool call looks like so far."""
        value = buffer.lstrip()
        if not value:
            return "incomplete"
        if value.startswith(CMD_TOOL_CALL_OPEN_TAG):
            return "tool_call"
        if value.startswith(CMD_WAIT_TOOL_RESULT_TAG):
            return "wait_marker"
        # Both tags share the "<cmd:" prefix, so a buffer that is still a prefix of
        # either one has to wait rather than being judged now.
        if CMD_TOOL_CALL_OPEN_TAG.startswith(value):
            return "incomplete"
        if CMD_WAIT_TOOL_RESULT_TAG.startswith(value):
            return "incomplete"
        return "invalid"

    async def _process_buffered_tool_calls(self, buffer_text: str) -> _BufferResult:
        """Pop complete tool calls off the left of the buffer and write them out.

        Nothing is executed here; the whole batch is written first and run later,
        which is what makes parallel tool calls possible.
        """
        buffer = buffer_text

        while True:
            classification = self._classify_buffer(buffer)

            if classification == "incomplete":
                return _BufferResult(remaining=buffer)

            if classification == "wait_marker":
                # The marker is a control signal: consumed here, never written, and
                # anything the model streamed after it is dropped.
                logger.debug("End-of-batch marker found in buffer, ending the turn")
                return _BufferResult(remaining="", stop=True, wait_marker=True)

            if classification == "invalid":
                # A model that forgot the marker still gets its batch executed:
                # prose after the last tool call ends the turn just as the marker
                # would.
                logger.debug("Buffered content is not another tool call, ending the turn")
                return _BufferResult(remaining="", stop=True)

            completed = check_for_completed_tool_call(buffer)
            if completed is None:
                return _BufferResult(remaining=buffer)

            call_text = buffer[: completed.end_index]
            logger.debug("Emitting parallel tool call (%d chars)", len(call_text))
            if not self._append(call_text):
                self.state.active = False
                return _BufferResult(remaining="", stop=True, failed=True)
            buffer = buffer[completed.end_index :]

    def _trim_wait_marker(
        self, rendered: str, current: str, scan_start: int, scan_end: int
    ) -> tuple[str, bool]:
        """Keep the end-of-batch marker out of a write where nothing completed.

        A complete marker here means the model asked for results it never
        requested, so the write is cut at it and the caller ends the turn. A
        trailing fragment that could still become one is held back instead.
        """
        if scan_end <= scan_start:
            return rendered, False

        already = len(self.state.written)
        section = current[scan_start:scan_end]

        marker_index = find_wait_marker(section)
        if marker_index != -1:
            logger.debug("End-of-batch marker without a completed tool call, cutting it out")
            keep = max(0, scan_start + marker_index - already)
            return rendered[:keep], True

        # Only a fragment at the very end of what has been generated can still grow
        # into the marker. A text section closed by a later thinking section cannot.
        if scan_end < len(current):
            return rendered, False

        hold_back = wait_marker_prefix_length(section)
        if hold_back == 0:
            return rendered, False

        keep = max(0, len(current) - hold_back - already)
        self.state.pending_text = current[len(current) - hold_back :]
        logger.debug("Holding back %d chars that may become the marker", hold_back)
        return rendered[:keep], False

    def _with_pending_text(self, events: list[StreamEvent]) -> list[StreamEvent]:
        """Re-deliver held-back text ahead of this batch.

        Prepended as a raw event rather than to the rendered output, so the section
        state machine accounts for it when it computes the scan offsets, and so it
        is escaped exactly once — escaping it before withholding it would escape it
        again on the way back in.
        """
        pending = self.state.pending_text
        if not pending:
            return list(events)
        self.state.pending_text = ""
        restored: StreamEvent = (
            ThinkingDelta(pending) if self.state.pending_is_thinking else TextDelta(pending)
        )
        self.state.pending_is_thinking = False
        return [restored, *events]

    @staticmethod
    def _coalesce(events: list[StreamEvent]) -> list[StreamEvent]:
        """Merge adjacent content events of the same kind.

        Purely so the tail of the batch can be looked at as one string; the
        renderer concatenates them anyway, so nothing changes.
        """
        merged: list[StreamEvent] = []
        for event in events:
            previous = merged[-1] if merged else None
            if isinstance(event, TextDelta) and isinstance(previous, TextDelta):
                merged[-1] = TextDelta(previous.text + event.text)
            elif isinstance(event, ThinkingDelta) and isinstance(previous, ThinkingDelta):
                merged[-1] = ThinkingDelta(previous.text + event.text)
            else:
                merged.append(event)
        return merged

    def _hold_back_marker_line(self, events: list[StreamEvent]) -> list[StreamEvent]:
        """Withhold a trailing partial line that might still become a marker.

        A marker is only a marker once its line ends: `# %% user` could still turn
        into `# %% username`. Escaping it early would corrupt ordinary prose, and
        writing it raw would split the document, so it waits for the newline.

        Only the tail needs checking. Any earlier partial line was withheld by this
        same rule on a previous batch and has just been prepended, so by induction
        the undecided line is always wholly inside this batch. The one exception is
        a block that already held a partial marker line before streaming began — a
        resumed turn — which append-only writing cannot go back and fix.
        """
        if not events:
            return events
        last = events[-1]
        if not isinstance(last, TextDelta | ThinkingDelta):
            return events

        newline = last.text.rfind("\n")
        line = last.text[newline + 1 :]
        if not line or not could_become_marker_line(line):
            return events

        self.state.pending_text = line
        self.state.pending_is_thinking = isinstance(last, ThinkingDelta)
        kept = last.text[: newline + 1]
        if not kept:
            return events[:-1]
        head: StreamEvent = (
            ThinkingDelta(kept) if isinstance(last, ThinkingDelta) else TextDelta(kept)
        )
        return [*events[:-1], head]

    # -- document writes --------------------------------------------------- #

    def _read(self) -> str:
        return self.path.read_text(encoding="utf-8")

    def _write(self, text: str) -> None:
        # In place, holding the chat file's lock. Not an atomic rename: swapping the
        # inode would detach any editor watching this path.
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(text)

    def _append_at_eof(self, addition: str) -> None:
        """Append to the file without rewriting what is already there.

        Streaming inserts at the end of the assistant block, which for the block
        being streamed into is the end of the file, so the usual read-slice-rewrite
        produced a byte-identical copy of the whole document on every token batch.
        On a 4M character chat that was ~10ms and 4MB of writes per batch, i.e.
        hundreds of megabytes over a single turn. Only ever called when the
        insertion point is exactly the current end of the file, where appending and
        rewriting give the same result.
        """
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(addition)

    def _target_content_start(self, text: str) -> int | None:
        """Where the block being streamed into begins.

        The first write goes into the first *empty* assistant block; later writes
        continue in the last one, which is that same block grown by our own writes.
        """
        blocks = find_all_assistant_blocks(text)
        if not blocks:
            logger.warning("No assistant block found in %s", self.path)
            return None

        if self.state.tokens:
            return blocks[-1].content_start

        for index, block in enumerate(blocks):
            next_start = (
                blocks[index + 1].marker_start if index + 1 < len(blocks) else len(text)
            )
            if not text[block.content_start : next_start].strip():
                return block.content_start

        logger.warning("No empty assistant block to stream into in %s", self.path)
        return None

    def _append(self, rendered: str) -> bool:
        """Append to the assistant block, or stop the streamer if it moved.

        Returns False when the document no longer starts with what was written,
        which means someone edited it and this stream can no longer be trusted.
        """
        if not rendered:
            return True
        try:
            text = self._read()
        except OSError as error:
            logger.error("Could not read %s: %s", self.path, error)
            self.state.active = False
            return False

        first_write = not self.state.tokens
        content_start = self._target_content_start(text)
        if content_start is None:
            self.state.active = False
            return False

        written = self.state.written
        if not text[content_start:].startswith(written):
            logger.warning(
                "Document no longer matches what was streamed, stopping (expected %r)",
                written[:40],
            )
            self.state.active = False
            return False

        insert_at = content_start + len(written)
        to_insert = rendered
        if first_write and content_start > 0 and text[content_start - 1] != "\n":
            # The marker line had no newline after it, so give the content one.
            to_insert = "\n" + rendered

        try:
            if insert_at == len(text):
                self._append_at_eof(to_insert)
            else:
                self._write(text[:insert_at] + to_insert + text[insert_at:])
        except OSError as error:
            logger.error("Could not write %s: %s", self.path, error)
            self.state.active = False
            return False

        # The history records what we contributed to the block, not the newline that
        # only separates it from the marker; the marker offset absorbs that.
        self.state.tokens.append(rendered)
        return True

    def _insert_after_written(self, addition: str) -> bool:
        """Insert text immediately after what this turn wrote into the block."""
        try:
            text = self._read()
        except OSError as error:
            logger.error("Could not read %s: %s", self.path, error)
            return False

        blocks = find_all_assistant_blocks(text)
        if not blocks:
            logger.warning("No assistant block found, cannot append to %s", self.path)
            return False

        offset = blocks[-1].content_start + len(self.state.written)
        offset = min(offset, len(text))
        payload = block_marker_prefix(text[:offset]) + addition
        try:
            self._write(text[:offset] + payload + text[offset:])
        except OSError as error:
            logger.error("Could not write %s: %s", self.path, error)
            return False
        return True

    def _insert_tool_execute_block(self) -> None:
        """Add one tool_execute block after the batch of tool calls just written.

        One block, not one per call: the driver runs the calls one at a time and
        adds another block after each result until the batch is done.
        """
        if self._insert_after_written("# %% tool_execute\n"):
            logger.debug("Inserted tool_execute block in %s", self.path)

    def _append_new_user_block(self) -> None:
        if self._insert_after_written("# %% user\n"):
            logger.debug("Appended user block to %s", self.path)

    def _append_correction_turn(self, message: str) -> None:
        """Append a user turn plus an empty assistant block, so streaming resumes.

        The empty assistant block is the trigger: the document itself asks for the
        retry, exactly as it would if a person had typed it.
        """
        self.state.active = False
        if self._insert_after_written(f"# %% user\n{message}\n\n# %% assistant\n"):
            logger.info("Appended correction turn to %s", self.path)

    def _describe_tool_call_format(self) -> str:
        """Spell the format out, since guidance a model could misread just repeats."""
        return (
            f"Use the exact format: {CMD_TOOL_CALL_OPEN_TAG} on its own line, then "
            "<cmd:tool_name>...</cmd:tool_name>, then one "
            '<cmd:param name="...">...</cmd:param> per parameter, then '
            f"</cmd:tool_call> on its own line, then {CMD_WAIT_TOOL_RESULT_TAG} once "
            "after the last call of the batch. No triple-backtick fences."
        )

    def _append_malformed_tool_correction(self) -> None:
        self._append_correction_turn(
            f"That response used the {CMD_NAMESPACE_PREFIX} namespace but contained no "
            f"valid tool call. {self._describe_tool_call_format()}"
        )

    def _append_stray_wait_marker_correction(self) -> None:
        self._append_correction_turn(
            f"That response ended with {CMD_WAIT_TOOL_RESULT_TAG} but contained no valid "
            "tool call, so nothing ran and there are no results. "
            f"{self._describe_tool_call_format()} If no tool is needed, answer directly "
            "and leave the marker out."
        )

    # -- helpers ----------------------------------------------------------- #

    def _record_payload(self, model: str, payload: ThinkingPayload) -> str | None:
        """Store a reasoning payload and return the line that references it."""
        try:
            directory = assets_dir(self.path.parent, self.assets_path)
            hash_ = put_thinking_entry(directory, model, payload)
        except OSError as error:
            # A payload that cannot be stored is not worth losing the turn over; the
            # thinking degrades to display-only text.
            logger.warning("Could not store thinking payload: %s", error)
            return None
        return format_signature_line(model, hash_)

    def _count_tool_calls(self) -> int:
        from ..tools.call_parser import find_all_tool_calls

        return len(find_all_tool_calls(strip_thinking_sections(self.state.written)))

    def _with_partial_assistant(self, messages: list[MessageParam]) -> list[MessageParam]:
        """Fold the partial turn into the context before restarting the stream."""
        written = self.state.written
        if not written:
            return list(messages)

        partial = parse_assistant_content(
            written, self.path.parent, assets_path=self.assets_path
        )
        if not partial:
            return list(messages)

        updated = list(messages)
        if updated and updated[-1].role == "assistant":
            last = updated[-1]
            updated[-1] = MessageParam(role="assistant", content=[*last.content, *partial])
        else:
            updated.append(MessageParam(role="assistant", content=partial))
        return updated


__all__ = [
    "FileStreamer",
    "StreamOutcome",
    "StreamResult",
    "StreamerState",
    "ThinkingPayloadDelta",
]
