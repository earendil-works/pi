"""Stdout guard for machine-readable modes (print json, rpc).

Ported from packages/coding-agent/src/core/output-guard.ts.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Callable

_RAW_STDOUT_RETRY_DELAY_S = 0.01

_stdout_takeover_state: dict[str, object] | None = None
_raw_stdout_write_tail: asyncio.Future[None] | None = None
_raw_stdout_write_chain: list[asyncio.Task[None]] = []


def _get_loop() -> asyncio.AbstractEventLoop:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.get_event_loop()


def _get_raw_stdout_write() -> Callable[..., bool]:
    if _stdout_takeover_state is not None:
        return _stdout_takeover_state["raw_stdout_write"]  # type: ignore[return-value]
    return sys.stdout.write


async def _write_raw_stdout_chunk(text: str) -> None:
    while True:
        try:
            write = _get_raw_stdout_write()

            def _write() -> None:
                write(text)

            await asyncio.to_thread(_write)
            return
        except OSError as error:
            code = getattr(error, "errno", None)
            if code not in (11, 35, 105):  # EAGAIN, EWOULDBLOCK, ENOBUFS on common platforms
                raise


def take_over_stdout() -> None:
    global _stdout_takeover_state
    if _stdout_takeover_state is not None:
        return

    raw_stdout_write = sys.stdout.write
    raw_stderr_write = sys.stderr.write
    original_stdout_write = sys.stdout.write

    def redirected_write(
        chunk: str | bytes,
        encoding_or_callback: object | None = None,
        callback: object | None = None,
    ) -> bool:
        text = chunk.decode("utf-8", errors="replace") if isinstance(chunk, bytes) else str(chunk)
        if callable(encoding_or_callback):
            return raw_stderr_write(text, encoding_or_callback)  # type: ignore[arg-type]
        return raw_stderr_write(text, callback)  # type: ignore[arg-type]

    sys.stdout.write = redirected_write  # type: ignore[assignment]
    _stdout_takeover_state = {
        "raw_stdout_write": raw_stdout_write,
        "raw_stderr_write": raw_stderr_write,
        "original_stdout_write": original_stdout_write,
    }


def restore_stdout() -> None:
    global _stdout_takeover_state
    if _stdout_takeover_state is None:
        return
    sys.stdout.write = _stdout_takeover_state["original_stdout_write"]  # type: ignore[assignment]
    _stdout_takeover_state = None


def is_stdout_taken_over() -> bool:
    return _stdout_takeover_state is not None


def write_raw_stdout(text: str) -> None:
    if not text:
        return

    async def _enqueue() -> None:
        await _write_raw_stdout_chunk(text)

    loop = _get_loop()
    task = loop.create_task(_enqueue())
    _raw_stdout_write_chain.append(task)

    def _done(done_task: asyncio.Task[None]) -> None:
        if done_task in _raw_stdout_write_chain:
            _raw_stdout_write_chain.remove(done_task)
        if done_task.cancelled():
            return
        exc = done_task.exception()
        if exc is not None:
            raise SystemExit(1) from exc

    task.add_done_callback(_done)


async def wait_for_raw_stdout_backpressure() -> None:
    while _raw_stdout_write_chain:
        pending = list(_raw_stdout_write_chain)
        await asyncio.gather(*pending, return_exceptions=True)


async def flush_raw_stdout() -> None:
    await wait_for_raw_stdout_backpressure()
    await _write_raw_stdout_chunk("")
