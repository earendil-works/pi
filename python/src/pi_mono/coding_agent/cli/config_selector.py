"""CLI entry for `pi config`."""

from __future__ import annotations

import asyncio

from pi_mono.coding_agent.core.package_manager import PackageManager
from pi_mono.coding_agent.modes.interactive.components.config_selector import (
    ConfigSelectorComponent,
    flatten_resolved_paths,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.tui.terminal import ProcessTerminal
from pi_mono.tui.tui import TUI


async def select_config(
    *,
    cwd: str,
    agent_dir: str,
    settings_manager: SettingsManager,
) -> None:
    init_theme(settings_manager.get_theme())
    package_manager = PackageManager(cwd, agent_dir, settings_manager)
    resolved = await package_manager.resolve()
    items = flatten_resolved_paths(resolved)

    loop = asyncio.get_running_loop()
    future: asyncio.Future[None] = loop.create_future()
    ui = TUI(ProcessTerminal(), show_hardware_cursor=settings_manager.get_show_hardware_cursor())

    def on_close() -> None:
        ui.stop()
        if not future.done():
            future.set_result(None)

    selector = ConfigSelectorComponent(items, settings_manager, on_close)
    ui.add_child(selector)
    ui.set_focus(selector)
    ui.start()
    await future
