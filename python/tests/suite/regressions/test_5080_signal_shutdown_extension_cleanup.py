"""Issue #5080: signal shutdown must emit session_shutdown before terminal cleanup."""

from __future__ import annotations

import os
import sys
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pi_mono.coding_agent.modes.interactive.interactive_mode import (
    InteractiveMode,
    format_resume_command,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.config import APP_NAME


@pytest.fixture(autouse=True)
def _init_theme() -> None:
    init_theme("dark")


class ProcessExitError(Exception):
    pass


def _make_shutdown_mode(*, session_manager: MagicMock | None = None) -> InteractiveMode:
    mode = InteractiveMode.__new__(InteractiveMode)
    mode._is_shutting_down = False
    mode._is_initialized = True
    mode._ui = MagicMock()
    mode._unregister_signal_handlers = MagicMock()
    mode._runtime_host = MagicMock()
    mode._runtime_host.dispose = AsyncMock()
    manager = session_manager or MagicMock()
    if session_manager is None:
        manager.is_persisted.return_value = False
    mode._session = type("_SessionRef", (), {"session_manager": manager})()
    return mode


@pytest.mark.anyio
async def test_signal_shutdown_emits_session_shutdown_before_terminal_writes() -> None:
    order: list[str] = []
    mode = _make_shutdown_mode()
    mode._runtime_host.dispose = AsyncMock(side_effect=lambda: order.append("dispose"))
    mode._drain_terminal_input = AsyncMock(side_effect=lambda: order.append("drainInput"))
    mode.stop = AsyncMock(side_effect=lambda: order.append("stop"))

    with patch.object(sys, "exit", side_effect=ProcessExitError):
        with pytest.raises(ProcessExitError):
            await InteractiveMode._shutdown(mode, from_signal=True, signum=15)

    assert order == ["dispose", "drainInput", "stop"]
    assert mode._is_shutting_down is True


@pytest.mark.anyio
async def test_interactive_quit_stops_tui_before_session_shutdown() -> None:
    order: list[str] = []
    mode = _make_shutdown_mode()
    mode._runtime_host.dispose = AsyncMock(side_effect=lambda: order.append("dispose"))
    mode._drain_terminal_input = AsyncMock(side_effect=lambda: order.append("drainInput"))
    mode.stop = AsyncMock(side_effect=lambda: order.append("stop"))

    await InteractiveMode._shutdown(mode)

    assert order == ["drainInput", "stop", "dispose"]


@pytest.mark.anyio
async def test_interactive_quit_prints_resume_hint_for_persisted_sessions() -> None:
    order: list[str] = []
    with tempfile.TemporaryDirectory() as temp_dir:
        session_file = os.path.join(temp_dir, "session.jsonl")
        with open(session_file, "w", encoding="utf-8") as handle:
            handle.write("\n")
        session_manager = MagicMock()
        session_manager.is_persisted.return_value = True
        session_manager.get_session_file.return_value = session_file
        session_manager.uses_default_session_dir.return_value = True
        session_manager.get_session_id.return_value = "test-session"

        mode = _make_shutdown_mode(session_manager=session_manager)
        mode._runtime_host.dispose = AsyncMock(side_effect=lambda: order.append("dispose"))
        mode._drain_terminal_input = AsyncMock(side_effect=lambda: order.append("drainInput"))
        mode.stop = AsyncMock(side_effect=lambda: order.append("stop"))

        with (
            patch.object(sys.stdout, "isatty", return_value=True),
            patch.object(sys.stdout, "write") as stdout_write,
        ):
            await InteractiveMode._shutdown(mode)

        assert order == ["drainInput", "stop", "dispose"]
        written = "".join(str(call.args[0]) for call in stdout_write.call_args_list)
        assert "To resume this session:" in written
        assert "test-session" in written


@pytest.mark.anyio
async def test_signal_shutdown_does_not_print_resume_hint() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        session_file = os.path.join(temp_dir, "session.jsonl")
        with open(session_file, "w", encoding="utf-8") as handle:
            handle.write("\n")
        session_manager = MagicMock()
        session_manager.is_persisted.return_value = True
        session_manager.get_session_file.return_value = session_file
        session_manager.uses_default_session_dir.return_value = True
        session_manager.get_session_id.return_value = "test-session"

        mode = _make_shutdown_mode(session_manager=session_manager)
        mode._drain_terminal_input = AsyncMock()
        mode.stop = AsyncMock()

        with (
            patch.object(sys.stdout, "isatty", return_value=True),
            patch.object(sys.stdout, "write") as stdout_write,
            patch.object(sys, "exit", side_effect=ProcessExitError),
        ):
            with pytest.raises(ProcessExitError):
                await InteractiveMode._shutdown(mode, from_signal=True, signum=15)

        for call in stdout_write.call_args_list:
            assert "To resume this session:" not in str(call.args[0])


@pytest.mark.anyio
async def test_reentrant_shutdown_is_no_op() -> None:
    order: list[str] = []
    mode = _make_shutdown_mode()
    mode._is_shutting_down = True
    mode._runtime_host.dispose = AsyncMock(side_effect=lambda: order.append("dispose"))

    await InteractiveMode._shutdown(mode, from_signal=True, signum=15)

    assert order == []
    mode._runtime_host.dispose.assert_not_called()


def test_format_resume_command_matches_session_id() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        session_file = os.path.join(temp_dir, "session.jsonl")
        with open(session_file, "w", encoding="utf-8") as handle:
            handle.write("\n")
        session_manager = MagicMock()
        session_manager.is_persisted.return_value = True
        session_manager.get_session_file.return_value = session_file
        session_manager.uses_default_session_dir.return_value = True
        session_manager.get_session_id.return_value = "test-session"

        with patch.object(sys.stdout, "isatty", return_value=True):
            assert format_resume_command(session_manager) == f"{APP_NAME} --session test-session"
