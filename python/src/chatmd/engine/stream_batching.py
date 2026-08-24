"""Time-based batching of provider stream events.

The streamer writes to a file on disk, so it coalesces events into ~100ms batches
rather than writing once per token. Batching also gives tool-call detection a
useful unit of work: a batch is scanned once, not per token.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterable, AsyncIterator

from ..types import StreamEvent

DEFAULT_BATCH_INTERVAL = 0.1


class _Sentinel:
    """Marks the end of the source stream inside a pending task."""


_END = _Sentinel()


async def _next_or_end(iterator: AsyncIterator[StreamEvent]) -> StreamEvent | _Sentinel:
    try:
        return await iterator.__anext__()
    except StopAsyncIteration:
        return _END


async def batched_events(
    source: AsyncIterable[StreamEvent],
    interval: float = DEFAULT_BATCH_INTERVAL,
) -> AsyncIterator[list[StreamEvent]]:
    """Yield lists of events collected over `interval` seconds each.

    A failure from the source is held back until everything already collected has
    been yielded, then raised. Providers signal a truncated response by failing
    mid-stream, and the text they produced before failing is exactly what the
    caller needs in order to continue the turn instead of restarting it.

    Closing this generator early closes the source, which aborts the underlying
    request. That matters: a turn ends the moment a tool call batch is complete,
    and without the abort the process would sit and pay for tokens nobody reads.
    """
    iterator = source.__aiter__()
    pending: list[StreamEvent] = []
    task: asyncio.Task[StreamEvent | _Sentinel] | None = None
    exhausted = False
    failure: Exception | None = None

    try:
        while not exhausted and failure is None:
            deadline = time.monotonic() + interval
            while True:
                if task is None:
                    task = asyncio.ensure_future(_next_or_end(iterator))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    # Shielded so a timeout leaves the in-flight read running; the
                    # next pass awaits the same task instead of dropping an event.
                    event = await asyncio.wait_for(asyncio.shield(task), remaining)
                except TimeoutError:
                    break
                except Exception as error:  # noqa: BLE001 - re-raised below, after flushing
                    task = None
                    failure = error
                    break
                task = None
                if isinstance(event, _Sentinel):
                    exhausted = True
                    break
                pending.append(event)

            if pending:
                yield pending
                pending = []
    finally:
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        aclose = getattr(iterator, "aclose", None)
        if aclose is not None:
            await aclose()

    if failure is not None:
        raise failure
