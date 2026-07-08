"""Startup UI helpers for first-time setup and selectors."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from pi_mono.coding_agent.core.experimental import are_experimental_features_enabled
from pi_mono.config import APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, PACKAGE_NAME, get_agent_dir
from pi_mono.coding_agent.core.keybindings import CodingAgentKeybindingsManager
from pi_mono.coding_agent.modes.interactive.components.first_time_setup import (
    FirstTimeSetupComponent,
    FirstTimeSetupResult,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.tui.keybindings import set_keybindings
from pi_mono.tui.terminal import ProcessTerminal
from pi_mono.tui.tui import TUI

OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent"
OFFICIAL_APP_NAME = "pi"
OFFICIAL_CONFIG_DIR_NAME = ".pi"


def _is_official_distribution() -> bool:
    return (
        PACKAGE_NAME == OFFICIAL_PACKAGE_NAME
        and APP_NAME == OFFICIAL_APP_NAME
        and CONFIG_DIR_NAME == OFFICIAL_CONFIG_DIR_NAME
    )


def should_run_first_time_setup(settings_path: str | None = None) -> bool:
    if not _is_official_distribution():
        return False
    if not are_experimental_features_enabled():
        return False
    if os.environ.get(ENV_AGENT_DIR):
        return False
    path = Path(settings_path or (get_agent_dir() / "settings.json"))
    return not path.is_file()


def _create_startup_tui(settings_manager: SettingsManager) -> TUI:
    init_theme(settings_manager.get_theme())
    set_keybindings(CodingAgentKeybindingsManager.create(str(get_agent_dir())))
    return TUI(ProcessTerminal(), show_hardware_cursor=settings_manager.get_show_hardware_cursor())


async def show_first_time_setup(settings_manager: SettingsManager) -> FirstTimeSetupResult | None:
    loop = asyncio.get_running_loop()
    future: asyncio.Future[FirstTimeSetupResult | None] = loop.create_future()
    ui = _create_startup_tui(settings_manager)
    detected_theme = settings_manager.get_theme() or "dark"

    def on_submit(result: FirstTimeSetupResult) -> None:
        settings_manager.set_theme(result.theme)
        settings_manager.set_enable_install_telemetry(result.share_analytics)
        settings_manager.save()
        ui.stop()
        if not future.done():
            future.set_result(result)

    def on_cancel() -> None:
        ui.stop()
        if not future.done():
            future.set_result(None)

    component = FirstTimeSetupComponent(
        detected_theme=detected_theme,
        on_theme_preview=lambda theme_name: init_theme(theme_name),
        on_submit=on_submit,
        on_cancel=on_cancel,
    )
    ui.add_child(component)
    ui.set_focus(component)
    ui.start()
    return await future
