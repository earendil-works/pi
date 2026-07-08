"""TUI session selector for --resume."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from pi_mono.coding_agent.cli.session_format import format_session_date as format_session_date
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.tui.components.select_list import SelectItem
from pi_mono.tui.terminal import ProcessTerminal
from pi_mono.tui.tui import TUI

SessionsLoader = Callable[[Callable[[int, int], None] | None], Awaitable[list[dict[str, Any]]]]


def sessions_to_select_items(sessions: list[dict[str, Any]]) -> list[SelectItem]:
    from pi_mono.coding_agent.modes.interactive.components.session_selector import (
        sessions_to_select_items as _sessions_to_select_items,
    )

    return _sessions_to_select_items(sessions)


async def select_session(
    current_sessions_loader: SessionsLoader,
    all_sessions_loader: SessionsLoader,
) -> str | None:
    """Show TUI session selector and return selected session path or None."""
    init_theme("dark")

    loop = asyncio.get_running_loop()
    future: asyncio.Future[str | None] = loop.create_future()

    ui = TUI(ProcessTerminal())
    resolved = False

    def resolve(value: str | None) -> None:
        nonlocal resolved
        if resolved:
            return
        resolved = True
        ui.stop()
        if not future.done():
            future.set_result(value)

    from pi_mono.coding_agent.modes.interactive.components.session_selector import (
        SessionSelectorComponent,
    )

    selector = SessionSelectorComponent(
        ui,
        current_sessions_loader,
        all_sessions_loader,
        on_select=lambda path: resolve(path),
        on_cancel=lambda: resolve(None),
        on_exit=lambda: resolve(None),
    )
    ui.add_child(selector)
    ui.set_focus(selector)
    ui.start()

    return await future
