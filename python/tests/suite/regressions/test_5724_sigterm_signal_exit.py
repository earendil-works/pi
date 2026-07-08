"""Issue #5724: keep signal handlers registered until async cleanup completes."""

from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pi_mono.coding_agent.modes.interactive.interactive_mode import InteractiveMode


class ProcessExitError(Exception):
    pass


@pytest.mark.anyio
async def test_keeps_signal_handlers_registered_while_signal_cleanup_is_pending() -> None:
    order: list[str] = []
    dispose_started = asyncio.Event()
    dispose_finish = asyncio.Event()

    mode = InteractiveMode.__new__(InteractiveMode)
    mode._is_shutting_down = False
    mode._is_initialized = True
    mode._ui = MagicMock()
    mode._session = type("_SessionRef", (), {"session_manager": MagicMock()})()

    async def dispose() -> None:
        order.append("dispose")
        dispose_started.set()
        await dispose_finish.wait()

    mode._runtime_host = MagicMock()
    mode._runtime_host.dispose = dispose
    mode._drain_terminal_input = AsyncMock(side_effect=lambda: order.append("drainInput"))
    mode._unregister_signal_handlers = MagicMock(side_effect=lambda: order.append("unregister"))
    mode.stop = AsyncMock(side_effect=lambda: order.append("stop"))

    with patch.object(sys, "exit", side_effect=ProcessExitError):
        shutdown_task = asyncio.create_task(
            InteractiveMode._shutdown(mode, from_signal=True, signum=15)
        )
        await dispose_started.wait()

        assert order == ["dispose"]
        mode._unregister_signal_handlers.assert_not_called()

        dispose_finish.set()
        with pytest.raises(ProcessExitError):
            await shutdown_task

    assert order == ["dispose", "drainInput", "stop"]
