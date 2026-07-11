"""Reusable countdown timer for dialog components."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pi_mono.tui.tui import TUI


class CountdownTimer:
    """Tick once per second until timeout, then call on_expire."""

    def __init__(
        self,
        timeout_ms: int,
        tui: TUI | None,
        on_tick: Callable[[int], None],
        on_expire: Callable[[], None],
    ) -> None:
        self._tui = tui
        self._on_tick = on_tick
        self._on_expire = on_expire
        self._remaining_seconds = max(1, (timeout_ms + 999) // 1000)
        self._task: asyncio.Task[Any] | None = None
        self._disposed = False
        self._on_tick(self._remaining_seconds)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._task = loop.create_task(self._run())

    async def _run(self) -> None:
        while not self._disposed and self._remaining_seconds > 0:
            await asyncio.sleep(1)
            if self._disposed:
                return
            self._remaining_seconds -= 1
            self._on_tick(self._remaining_seconds)
            if self._tui is not None:
                self._tui.request_render()
            if self._remaining_seconds <= 0:
                self.dispose()
                self._on_expire()
                return

    def dispose(self) -> None:
        self._disposed = True
        task = self._task
        self._task = None
        if task is not None and not task.done():
            task.cancel()
