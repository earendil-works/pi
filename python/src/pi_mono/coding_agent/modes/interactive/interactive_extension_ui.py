"""Extension UI context for interactive TUI mode."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Literal

from pi_mono.coding_agent.modes.interactive.components.extension_input import (
    ExtensionInputComponent,
)
from pi_mono.coding_agent.modes.interactive.components.extension_selector import (
    ExtensionSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.tui import Container


class InteractiveExtensionUIContext:
    """Routes extension UI calls to the interactive editor area."""

    def __init__(
        self,
        *,
        show_status: Callable[[str], None],
        get_editor_text: Callable[[], str],
        set_editor_text: Callable[[str], None],
        show_component: Callable[[Container, Container], None],
        restore_editor: Callable[[], None],
    ) -> None:
        self._show_status = show_status
        self._get_editor_text = get_editor_text
        self._set_editor_text = set_editor_text
        self._show_component = show_component
        self._restore_editor = restore_editor

    async def select(
        self, title: str, options: list[str], opts: dict[str, Any] | None = None
    ) -> str | None:
        del opts
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str | None] = loop.create_future()

        def on_select(value: str) -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(value)

        def on_cancel() -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(None)

        selector = ExtensionSelectorComponent(title, options, on_select, on_cancel)
        self._show_component(selector, selector)
        return await future

    async def confirm(self, title: str, message: str, opts: dict[str, Any] | None = None) -> bool:
        del opts
        selected = await self.select(f"{title}\n{message}", ["Yes", "No"])
        return selected == "Yes"

    async def input(
        self,
        title: str,
        placeholder: str | None = None,
        opts: dict[str, Any] | None = None,
    ) -> str | None:
        del opts
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str | None] = loop.create_future()

        def on_submit(value: str) -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(value.strip() or None)

        def on_cancel() -> None:
            self._restore_editor()
            if not future.done():
                future.set_result(None)

        component = ExtensionInputComponent(
            title,
            on_submit,
            on_cancel,
            placeholder=placeholder,
        )
        self._show_component(component, component)
        return await future

    def notify(self, message: str, type: Literal["info", "warning", "error"] | None = None) -> None:
        color = "muted"
        if type == "warning":
            color = "warning"
        elif type == "error":
            color = "error"
        elif type == "info":
            color = "success"
        self._show_status(theme.fg(color, message))

    def get_editor_text(self) -> str:
        return self._get_editor_text()

    def set_editor_text(self, text: str) -> None:
        self._set_editor_text(text)
