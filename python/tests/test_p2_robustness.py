"""P2 robustness: RPC backpressure, child cleanup, migration UX, Cursor CLI reliability."""

from __future__ import annotations

import asyncio
import signal
import subprocess
import sys
from unittest.mock import MagicMock, patch

import pytest

from pi_mono.ai.cursor_agent import (
    check_cursor_agent_available,
    discover_cursor_models,
    refresh_cursor_models_cache,
)
from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.coding_agent.migrations import show_deprecation_warnings
from pi_mono.coding_agent.modes.rpc.rpc_mode import RpcMode
from pi_mono.core.session_manager import SessionManager
from pi_mono.utils import child_process
from pi_mono.utils.shell import (
    track_detached_child_pid,
    tracked_detached_child_pids,
)


@pytest.mark.anyio
async def test_rpc_rebind_registers_agent_backpressure_listener(tmp_path) -> None:
    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    before = len(result.session.agent.listeners)
    await mode._rebind_session()
    assert len(result.session.agent.listeners) == before + 1
    assert mode._backpressure_listener is not None


@pytest.mark.anyio
async def test_rpc_backpressure_listener_waits_for_stdout(tmp_path, monkeypatch) -> None:
    calls: list[int] = []

    async def mock_wait() -> None:
        calls.append(1)

    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.rpc.rpc_mode.wait_for_raw_stdout_backpressure",
        mock_wait,
    )
    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    await mode._rebind_session()
    assert mode._backpressure_listener is not None
    await mode._backpressure_listener({"type": "message_update"}, MagicMock())
    assert calls == [1]


@pytest.mark.anyio
async def test_rpc_shutdown_kills_tracked_children(tmp_path, monkeypatch) -> None:
    killed: list[bool] = []

    def mock_kill() -> None:
        killed.append(True)
        tracked_detached_child_pids.clear()

    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.rpc.rpc_mode.kill_tracked_detached_children",
        mock_kill,
    )
    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    track_detached_child_pid(424242)
    await mode.shutdown()
    assert killed == [True]
    assert 424242 not in tracked_detached_child_pids


@pytest.mark.anyio
async def test_rpc_signal_handler_kills_tracked_children_before_shutdown(
    tmp_path, monkeypatch
) -> None:
    killed: list[bool] = []

    def mock_kill() -> None:
        killed.append(True)

    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.rpc.rpc_mode.kill_tracked_detached_children",
        mock_kill,
    )

    async def noop_shutdown(_signum: int | None = None) -> None:
        return None

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    monkeypatch.setattr(mode, "shutdown", noop_shutdown)
    mode._register_signal_handlers()
    handler = signal.getsignal(signal.SIGTERM)
    assert callable(handler)
    handler(signal.SIGTERM, None)
    await asyncio.sleep(0.05)
    assert killed


@pytest.mark.anyio
async def test_show_deprecation_warnings_waits_on_tty(monkeypatch) -> None:
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)

    def fake_read(_n: int) -> str:
        return "x"

    monkeypatch.setattr("pi_mono.coding_agent.migrations.sys.stdin.read", fake_read)
    stderr_lines: list[str] = []

    def capture_stderr(text: str) -> None:
        stderr_lines.append(text)

    monkeypatch.setattr(
        "pi_mono.coding_agent.migrations._write_stderr",
        capture_stderr,
    )
    await show_deprecation_warnings(["Global hooks/ directory found."])
    assert any("Press any key" in line for line in stderr_lines)


@pytest.mark.anyio
async def test_show_deprecation_warnings_skips_wait_when_not_tty(monkeypatch) -> None:
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    read_called = False

    def fake_read(_n: int) -> str:
        nonlocal read_called
        read_called = True
        return "x"

    monkeypatch.setattr("pi_mono.coding_agent.migrations.sys.stdin.read", fake_read)
    await show_deprecation_warnings(["Global hooks/ directory found."])
    assert read_called is False


def test_check_cursor_agent_available_raises_when_missing(monkeypatch) -> None:
    monkeypatch.setattr(
        "pi_mono.ai.cursor_agent.resolve_cursor_agent_path",
        lambda: "/nonexistent/cursor-agent",
    )
    monkeypatch.setattr("shutil.which", lambda _path: None)
    with pytest.raises(RuntimeError, match="Cursor Agent CLI not found"):
        check_cursor_agent_available()


@pytest.fixture(autouse=True)
def clear_cursor_model_cache() -> None:
    refresh_cursor_models_cache()
    yield
    refresh_cursor_models_cache()


def test_discover_cursor_models_timeout_falls_back_to_static() -> None:
    with patch(
        "pi_mono.ai.cursor_agent._run_agent_sync",
        side_effect=subprocess.TimeoutExpired("agent", 15),
    ):
        models = discover_cursor_models(refresh=True)
    assert models
    assert models[0]["provider"] == "cursor"
    assert models[0]["id"] == "auto"


@pytest.mark.anyio
async def test_wait_for_child_process_reads_late_output() -> None:
    if sys.platform == "win32":
        pytest.skip("Unix shell test")

    process = await asyncio.create_subprocess_shell(
        'printf "HEAD\\n"; ( for i in 1 2 3 4 5 6; do sleep 0.05; printf "TICK$i\\n"; done ) &',
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    chunks: list[bytes] = []

    async def on_data(data: bytes) -> None:
        chunks.append(data)

    exit_code = await child_process.wait_for_child_process(process, on_data=on_data)
    output = b"".join(chunks).decode("utf-8", errors="replace")
    assert exit_code == 0
    assert "HEAD" in output
    assert "TICK6" in output
