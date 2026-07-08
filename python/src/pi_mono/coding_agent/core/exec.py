"""Shared command execution utilities for extensions and custom tools."""

from __future__ import annotations

import asyncio
import os
import signal
from typing import Any, TypedDict


class ExecOptions(TypedDict, total=False):
    signal: Any
    timeout: float
    cwd: str


class ExecResult(TypedDict):
    stdout: str
    stderr: str
    code: int
    killed: bool


async def exec_command(
    command: str,
    args: list[str],
    cwd: str,
    options: ExecOptions | None = None,
) -> ExecResult:
    opts = options or {}
    workdir = opts.get("cwd") or cwd
    abort_signal = opts.get("signal")
    timeout_ms = opts.get("timeout")

    if abort_signal is not None and getattr(abort_signal, "aborted", False):
        return {"stdout": "", "stderr": "", "code": 1, "killed": True}

    process = await asyncio.create_subprocess_exec(
        command,
        *args,
        cwd=workdir,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=os.name != "nt",
    )

    killed = False
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []

    async def _read_stream(stream: asyncio.StreamReader, sink: list[bytes]) -> None:
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            sink.append(chunk)

    stdout_task = asyncio.create_task(_read_stream(process.stdout, stdout_chunks))  # type: ignore[arg-type]
    stderr_task = asyncio.create_task(_read_stream(process.stderr, stderr_chunks))  # type: ignore[arg-type]

    async def _kill_process() -> None:
        nonlocal killed
        if killed or process.returncode is not None:
            return
        killed = True
        if process.pid is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                process.kill()

    abort_waiter: asyncio.Task[None] | None = None
    if abort_signal is not None and hasattr(abort_signal, "aborted"):
        abort_waiter = asyncio.create_task(_wait_for_abort(abort_signal, _kill_process))

    try:
        if timeout_ms and timeout_ms > 0:
            await asyncio.wait_for(process.wait(), timeout=timeout_ms / 1000.0)
        else:
            await process.wait()
    except asyncio.TimeoutError:
        await _kill_process()
        try:
            await process.wait()
        except Exception:
            pass
    finally:
        if abort_waiter is not None:
            abort_waiter.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    return {
        "stdout": b"".join(stdout_chunks).decode("utf-8", errors="replace"),
        "stderr": b"".join(stderr_chunks).decode("utf-8", errors="replace"),
        "code": process.returncode if process.returncode is not None else 1,
        "killed": killed,
    }


async def _wait_for_abort(abort_signal: Any, kill_process: Any) -> None:
    while not getattr(abort_signal, "aborted", False):
        await asyncio.sleep(0.05)
    await kill_process()
