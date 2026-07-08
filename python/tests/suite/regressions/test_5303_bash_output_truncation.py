"""Issue #5303: wait_for_child_process must not truncate late bash output."""

from __future__ import annotations

import asyncio
import sys

import pytest

from pi_mono.utils.child_process import wait_for_child_process


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX detached process behavior")
@pytest.mark.anyio
async def test_captures_output_after_exit_while_detached_child_holds_stdout_open() -> None:
    command = (
        'printf "HEAD\\n"; ( for i in 1 2 3 4 5 6; do sleep 0.05; printf "TICK$i\\n"; done ) &'
    )
    process = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    output = bytearray()

    def on_data(chunk: bytes) -> None:
        output.extend(chunk)

    try:
        exit_code = await wait_for_child_process(process, on_data=on_data)
    finally:
        if process.pid is not None:
            try:
                import os
                import signal

                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    text = output.decode("utf-8", errors="replace")
    assert exit_code == 0
    assert "HEAD" in text
    assert "TICK6" in text


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX detached process behavior")
@pytest.mark.anyio
async def test_resolves_promptly_when_detached_child_holds_stdout_open_but_stays_quiet() -> None:
    command = 'printf "DONE\\n"; ( sleep 30 ) >/dev/null 2>&1 &'
    process = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    output = bytearray()

    def on_data(chunk: bytes) -> None:
        output.extend(chunk)

    start = asyncio.get_running_loop().time()
    try:
        exit_code = await wait_for_child_process(process, on_data=on_data)
    finally:
        if process.pid is not None:
            try:
                import os
                import signal

                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    elapsed = asyncio.get_running_loop().time() - start

    text = output.decode("utf-8", errors="replace")
    assert exit_code == 0
    assert "DONE" in text
    assert elapsed < 2.0
