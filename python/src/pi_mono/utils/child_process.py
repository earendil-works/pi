"""Async child-process helpers."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

EXIT_STDIO_GRACE_SECONDS = 0.1


async def wait_for_child_process(
    process: asyncio.subprocess.Process,
    *,
    on_data: Callable[[bytes], Awaitable[None] | None] | None = None,
) -> int | None:
    """Wait for a child process without truncating late stdout/stderr (pi#5303)."""
    stdout = process.stdout
    stderr = process.stderr
    exited = False
    exit_code: int | None = None
    stdout_done = stdout is None
    stderr_done = stderr is None
    done_event = asyncio.Event()
    post_exit_timer: asyncio.Task[None] | None = None

    async def emit_data(data: bytes) -> None:
        if on_data is None:
            return
        result = on_data(data)
        if asyncio.iscoroutine(result):
            await result

    def maybe_done() -> None:
        if exited and stdout_done and stderr_done:
            done_event.set()

    def arm_idle_timer() -> None:
        nonlocal post_exit_timer
        if post_exit_timer is not None:
            post_exit_timer.cancel()

        async def timer() -> None:
            await asyncio.sleep(EXIT_STDIO_GRACE_SECONDS)
            done_event.set()

        post_exit_timer = asyncio.create_task(timer())

    async def read_stream(stream: asyncio.StreamReader | None, *, is_stdout: bool) -> None:
        nonlocal stdout_done, stderr_done
        if stream is None:
            return
        try:
            while True:
                chunk = await stream.read(65536)
                if not chunk:
                    break
                await emit_data(chunk)
                if exited and not done_event.is_set():
                    arm_idle_timer()
        finally:
            if is_stdout:
                stdout_done = True
            else:
                stderr_done = True
            maybe_done()

    read_tasks = [
        asyncio.create_task(read_stream(stdout, is_stdout=True)),
        asyncio.create_task(read_stream(stderr, is_stdout=False)),
    ]

    exit_code = await process.wait()
    exited = True
    maybe_done()
    if not done_event.is_set():
        arm_idle_timer()

    await done_event.wait()

    if post_exit_timer is not None:
        post_exit_timer.cancel()

    for task in read_tasks:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    return exit_code
