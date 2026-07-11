"""CLI entry for `pi config`."""

from __future__ import annotations

import asyncio
from typing import Literal

from pi_mono.coding_agent.core.package_manager import PackageManager
from pi_mono.coding_agent.modes.interactive.components.config_selector import (
    ConfigSelectorComponent,
    ScopedResolvedPaths,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.tui.terminal import ProcessTerminal
from pi_mono.tui.tui import TUI

ConfigWriteScope = Literal["global", "project"]


async def select_config(
    *,
    cwd: str,
    agent_dir: str,
    settings_manager: SettingsManager,
    resolved_paths: ScopedResolvedPaths | None = None,
    write_scope: ConfigWriteScope = "global",
    project_mode_available: bool = False,
) -> None:
    init_theme(settings_manager.get_theme())
    if resolved_paths is None:
        package_manager = PackageManager(cwd, agent_dir, settings_manager)
        resolved = await package_manager.resolve()
        resolved_paths = {"global": resolved, "project": resolved}

    loop = asyncio.get_running_loop()
    future: asyncio.Future[None] = loop.create_future()
    ui = TUI(ProcessTerminal(), show_hardware_cursor=settings_manager.get_show_hardware_cursor())

    def on_close() -> None:
        ui.stop()
        if not future.done():
            future.set_result(None)

    selector = ConfigSelectorComponent(
        resolved_paths,
        settings_manager,
        on_close,
        write_scope=write_scope,
        project_mode_available=project_mode_available,
    )
    ui.add_child(selector)
    ui.set_focus(selector)
    ui.start()
    await future
