"""Decides what a ``.chat.md`` file needs next, and does it.

Port of the decision logic in ``src/listener.ts``. The document is the entire
state machine: a trailing empty assistant block means "stream a turn", a trailing
empty tool_execute block means "run the next tool call", and anything else means
there is nothing to do. Because each action leaves the document in one of those
states, running steps until idle is what produces the agentic loop -- exactly the
loop the extension gets from re-triggering on its own edits.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from ..assets import TOOL_RESULT_LINE_THRESHOLD, ensure_chat_md_gitignore, write_tool_result_file
from ..config.model import ChatmdConfig
from ..errors import ChatmdError, ConfigError, LockHeld
from ..markers import escape_markers, unescape_markers
from ..mcp.manager import McpPool
from ..parser.blocks import (
    BLOCK_MARKER_RE,
    count_tool_execute_blocks,
    find_all_assistant_blocks,
    has_empty_assistant_block,
    has_empty_tool_execute_block,
)
from ..parser.document import parse_document
from ..providers.client import create_client
from ..providers.prompt import build_system_prompt
from ..render import strip_thinking_sections
from ..tools.call_parser import find_all_tool_calls, parse_tool_call
from ..tools.result_format import format_mcp_result, format_tool_result
from ..types import McpToolExecutionResult, Usage
from .locks import chat_file_lock
from .streamer import FileStreamer, StreamOutcome

logger = logging.getLogger(__name__)

_TOOL_EXECUTE_MARKER = "# %% tool_execute"
_ASSISTANT_MARKER = "# %% assistant"

#: Image markdown a tool emitted, which must be left unfenced so it renders.
_IMAGE_MARKDOWN = ("![", "](")


class StepAction(StrEnum):
    IDLE = "idle"
    STREAMED = "streamed"
    EXECUTED_TOOL = "executed_tool"
    LOCKED = "locked"
    ERROR = "error"


@dataclass
class StepResult:
    action: StepAction
    path: Path
    outcome: StreamOutcome | None = None
    tool_name: str | None = None
    usage: Usage | None = None
    message: str | None = None
    #: Which configuration actually served the turn, for grouping statistics.
    model: str | None = None
    provider: str | None = None
    config_name: str | None = None
    duration_ms: float = 0.0
    #: Characters the turn wrote into the document.
    characters: int = 0

    @property
    def is_terminal(self) -> bool:
        """Whether the loop should stop after this step.

        A turn that wrote nothing counts as terminal. The trigger block is still
        there, so continuing would make the identical request again, forever —
        which unattended means burning API calls in a loop rather than stopping.
        """
        if self.action in (StepAction.IDLE, StepAction.LOCKED, StepAction.ERROR):
            return True
        return self.action is StepAction.STREAMED and self.characters == 0


class ChatDriver:
    """Runs chat files to completion, one decision at a time."""

    def __init__(self, config: ChatmdConfig, pool: McpPool) -> None:
        self.config = config
        self.pool = pool

    # -- public ------------------------------------------------------------ #

    async def step(self, path: str | Path) -> StepResult:
        """Take whatever single action the document currently calls for."""
        target = Path(path)
        try:
            text = target.read_text(encoding="utf-8")
        except OSError as error:
            return StepResult(StepAction.ERROR, target, message=str(error))

        wants_stream = has_empty_assistant_block(text)
        wants_tool = has_empty_tool_execute_block(text)
        if not wants_stream and not wants_tool:
            return StepResult(StepAction.IDLE, target)

        # One lock per action rather than per run: between actions the document is
        # in a consistent state, and another writer -- the editor, most likely --
        # is entitled to take over there.
        lock = chat_file_lock(target)
        try:
            lock.acquire()
        except LockHeld as held:
            logger.debug("Skipping %s: %s", target, held)
            return StepResult(StepAction.LOCKED, target, message=str(held))

        try:
            if wants_stream:
                return await self._stream_turn(target, text)
            return await self._execute_next_tool_call(target, text)
        finally:
            lock.release()

    async def run(self, path: str | Path, *, max_rounds: int | None = None) -> list[StepResult]:
        """Step until the document is idle.

        Unbounded by default: a turn ends when the model stops calling tools, and
        capping rounds would cut off a long task mid-way. Callers that need a
        ceiling (tests, a one-shot CLI run) can pass one.
        """
        results: list[StepResult] = []
        rounds = 0
        while max_rounds is None or rounds < max_rounds:
            result = await self.step(path)
            results.append(result)
            if result.is_terminal:
                break
            rounds += 1
        return results

    # -- streaming --------------------------------------------------------- #

    async def _stream_turn(self, path: Path, text: str) -> StepResult:
        base_dir = path.parent
        try:
            parsed = parse_document(text, base_dir, assets_path=self.config.assets_path)
        except ChatmdError as error:
            logger.warning("Cannot parse %s: %s", path, error)
            return StepResult(StepAction.ERROR, path, message=str(error))

        if parsed.has_image_in_system_block:
            # Images in a system block are not supported by either provider, and
            # silently dropping them would misrepresent the prompt.
            message = "Images are not allowed in '# %% system' blocks."
            self._remove_trailing_empty_block(path, _ASSISTANT_MARKER)
            return StepResult(StepAction.ERROR, path, message=message)

        if not parsed.messages:
            logger.debug("Nothing to send for %s", path)
            self._remove_trailing_empty_block(path, _ASSISTANT_MARKER)
            return StepResult(StepAction.IDLE, path)

        try:
            resolved = self.config.resolve(overrides=parsed.file_config)
        except ConfigError as error:
            self._remove_trailing_empty_block(path, _ASSISTANT_MARKER)
            return StepResult(StepAction.ERROR, path, message=str(error))

        # Keep generated files out of the enclosing repository, without letting
        # git discovery delay the request.
        ensure_chat_md_gitignore(base_dir)

        system_prompt = build_system_prompt(
            parsed.system_prompt, self.pool.grouped_tools(), self.pool.grouped_resources()
        )
        streamer = FileStreamer(
            path, create_client(resolved), assets_path=resolved.assets_path
        )
        started = time.monotonic()
        result = await streamer.run(list(parsed.messages), system_prompt)

        return StepResult(
            StepAction.STREAMED,
            path,
            outcome=result.outcome,
            usage=result.usage,
            message=result.error,
            characters=result.characters_written,
            model=resolved.model_name,
            provider=resolved.provider,
            config_name=resolved.config_name,
            duration_ms=(time.monotonic() - started) * 1000.0,
        )

    # -- tool execution ---------------------------------------------------- #

    async def _execute_next_tool_call(self, path: Path, text: str) -> StepResult:
        block_start = self._last_empty_tool_execute_block(text)
        if block_start is None:
            return StepResult(StepAction.IDLE, path)

        calls, assistant_end = self._tool_calls_governing(text, block_start)
        if not calls:
            self._write_tool_result(
                path, text, block_start, "Error: No tool call found in assistant response", 0
            )
            return StepResult(
                StepAction.ERROR, path, message="No tool call found in assistant response"
            )

        # Each call gets its own tool_execute block, matched up positionally: the
        # number of blocks already sitting between the assistant block and this one
        # says which call is next.
        already_run = count_tool_execute_blocks(text[assistant_end:block_start])
        index = min(already_run, len(calls) - 1)
        pending_after = max(0, len(calls) - (already_run + 1))

        parsed_call = parse_tool_call(calls[index])
        if parsed_call is None:
            self._write_tool_result(
                path, text, block_start, "Error: Invalid tool call format", pending_after
            )
            return StepResult(StepAction.ERROR, path, message="Invalid tool call format")

        logger.info(
            "Running tool %s (%d of %d) for %s",
            parsed_call.name,
            index + 1,
            len(calls),
            path.name,
        )
        result = await self.pool.call(parsed_call.name, parsed_call.params)
        self._write_tool_result(path, text, block_start, result, pending_after)

        return StepResult(StepAction.EXECUTED_TOOL, path, tool_name=parsed_call.name)

    def _last_empty_tool_execute_block(self, text: str) -> int | None:
        """Offset of the marker of the last tool_execute block that has no content."""
        search_from = len(text)
        while True:
            found = text.rfind(_TOOL_EXECUTE_MARKER, 0, search_from)
            if found == -1:
                return None
            newline = text.find("\n", found)
            body_start = found + len(_TOOL_EXECUTE_MARKER) if newline == -1 else newline + 1
            if not text[body_start:].strip():
                return found
            search_from = found

    def _tool_calls_governing(self, text: str, block_start: int) -> tuple[list[str], int]:
        """The tool calls of the assistant block this tool_execute block belongs to.

        Also returns where that assistant block ends, which is the offset the
        caller counts already-executed blocks from. That end is the *first* marker
        after the assistant content — the first tool_execute block of the batch —
        not the block being filled now. Using the latter makes the span between
        them empty, so every pass would count zero completed calls and re-run the
        first tool forever.
        """
        blocks = [b for b in find_all_assistant_blocks(text) if b.marker_start < block_start]
        if not blocks:
            return [], 0

        last = blocks[-1]
        next_marker = BLOCK_MARKER_RE.search(text, last.content_start)
        assistant_end = (
            next_marker.start()
            if next_marker is not None and next_marker.start() <= block_start
            else block_start
        )
        body = text[last.content_start : assistant_end]
        # Thinking is stripped from the raw text -- an escaped "## %%% thinking"
        # is content, not a section -- and only then is the remainder unescaped,
        # so a call whose arguments contain marker lines is handed to the tool
        # exactly as the model wrote it rather than with the escaping still on.
        calls = find_all_tool_calls(unescape_markers(strip_thinking_sections(body)))
        return calls, assistant_end

    def _write_tool_result(
        self,
        path: Path,
        text: str,
        block_start: int,
        result: McpToolExecutionResult | str,
        pending_after: int,
    ) -> None:
        """Fill the empty tool_execute block and open the next block after it."""
        body, fenced = self._render_result(path.parent, result)

        # With calls still pending, the next block is another tool_execute so they
        # run one at a time; only once the batch is done does the model get a turn.
        next_marker = _TOOL_EXECUTE_MARKER if pending_after > 0 else _ASSISTANT_MARKER
        if pending_after > 0:
            logger.debug("%d tool call(s) still pending for %s", pending_after, path.name)

        # Escaped on the way in: a tool that read or wrote another chat returns
        # content full of marker lines, and writing those raw tears this document
        # apart -- the wrapper loses its other half and turns that never happened
        # appear in the history.
        wrapped = format_tool_result(escape_markers(body.strip()))
        rendered = f"\n{wrapped}\n\n{next_marker}\n" if not fenced else (
            f"\n```\n{wrapped}\n```\n\n{next_marker}\n"
        )

        newline = text.find("\n", block_start)
        body_start = (
            block_start + len(_TOOL_EXECUTE_MARKER) if newline == -1 else newline
        )
        # The empty block is by definition the last thing in the document, so the
        # replaced range runs to the end of the file.
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text[:body_start] + rendered)
        except OSError as error:
            logger.error("Could not write tool result to %s: %s", path, error)

    def _render_result(
        self, doc_dir: Path, result: McpToolExecutionResult | str
    ) -> tuple[str, bool]:
        """Render a result, spilling it to a file when it is too long to inline.

        Returns the body and whether it should be wrapped in a code fence. Rich
        results and anything containing image markdown must stay unfenced so the
        markdown still renders.
        """
        if isinstance(result, McpToolExecutionResult):
            markdown = format_mcp_result(result, doc_dir, self.config.assets_path)
            if len(markdown.splitlines()) > TOOL_RESULT_LINE_THRESHOLD:
                return self._spill(doc_dir, markdown, ".md"), False
            return markdown, False

        has_image = all(token in result for token in _IMAGE_MARKDOWN)
        if len(result.splitlines()) > TOOL_RESULT_LINE_THRESHOLD:
            return self._spill(doc_dir, result, ".txt"), False
        return result, not has_image

    def _spill(self, doc_dir: Path, content: str, extension: str) -> str:
        """Write a long result beside the chat and reference it by link.

        The link is read back and inlined at parse time, so the model still sees
        the whole result; only the document stays readable.
        """
        try:
            relative = write_tool_result_file(
                doc_dir, content, extension=extension, assets_path=self.config.assets_path
            )
        except OSError as error:
            logger.warning("Could not spill tool result to a file: %s", error)
            return content
        return f"[Tool Result]({relative})"

    def _remove_trailing_empty_block(self, path: Path, marker: str) -> None:
        """Drop a trigger block that cannot be acted on, so it stops re-firing."""
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return
        index = text.rfind(marker)
        if index == -1:
            return
        newline = text.find("\n", index)
        body_start = index + len(marker) if newline == -1 else newline + 1
        if text[body_start:].strip():
            return
        try:
            path.write_text(text[:index].rstrip("\n") + "\n", encoding="utf-8")
        except OSError as error:
            logger.warning("Could not remove the trigger block from %s: %s", path, error)
