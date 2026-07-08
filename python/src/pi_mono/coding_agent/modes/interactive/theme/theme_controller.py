"""Interactive theme controller with terminal OSC auto-sync."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pi_mono.coding_agent.modes.interactive.theme.theme import (
    Theme,
    TerminalTheme,
    detect_terminal_background_from_env,
    detect_terminal_background_theme,
    parse_auto_theme_setting,
    resolve_theme_setting,
    set_theme,
    set_theme_instance,
)
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.tui.terminal_colors import TerminalColorScheme


class InteractiveThemeController:
    def __init__(
        self,
        ui: Any,
        settings_manager: SettingsManager,
        show_error: Callable[[str], None],
        on_changed: Callable[[], None],
    ) -> None:
        self._ui = ui
        self._settings_manager = settings_manager
        self._show_error = show_error
        self._on_changed = on_changed
        self._terminal_theme: TerminalTheme = detect_terminal_background_from_env()["theme"]
        self._active_theme_name: str | None = None
        self._auto_sync_enabled = False

        self._active_theme_name = resolve_theme_setting(
            self._settings_manager.get_theme_setting(), self._terminal_theme
        )
        from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme

        init_theme(self._active_theme_name, enable_watcher=True)
        self._ui.on_terminal_color_scheme_change(self._apply_terminal_theme)

    async def apply_from_settings(self) -> None:
        theme_setting = self._settings_manager.get_theme_setting()
        auto_theme = parse_auto_theme_setting(theme_setting)
        if auto_theme:
            self._terminal_theme = await self._detect_terminal_theme_for_auto()
            self._set_auto_sync(True)
            theme_name = (
                auto_theme["lightTheme"]
                if self._terminal_theme == "light"
                else auto_theme["darkTheme"]
            )
            self._apply_theme_name(theme_name, show_error=True)
            return

        self._set_auto_sync(False)
        if theme_setting is not None:
            self._apply_theme_name(theme_setting, show_error=True)
            return

        detection = await detect_terminal_background_theme(ui=self._ui, timeout_ms=100)
        self._terminal_theme = detection["theme"]
        if not self._apply_theme_name(detection["theme"]).get("success"):
            return
        if detection["confidence"] == "high":
            self._settings_manager.set_theme(detection["theme"])
            await self._settings_manager.flush()

    def set_theme_name(self, theme_name: str, show_error: bool = False) -> dict[str, Any]:
        self._set_auto_sync(False)
        return self._apply_theme_name(theme_name, show_error=show_error)

    def set_theme_instance(self, theme_instance: Theme) -> dict[str, Any]:
        self._set_auto_sync(False)
        set_theme_instance(theme_instance)
        self._active_theme_name = "<in-memory>"
        self._notify_changed()
        return {"success": True}

    def preview(self, theme_setting_or_name: str) -> None:
        theme_name = (
            resolve_theme_setting(theme_setting_or_name, self._terminal_theme)
            or self._active_theme_name
        )
        if not theme_name:
            return
        if set_theme(theme_name, enable_watcher=True).get("success"):
            self._ui.invalidate()
            self._ui.request_render()

    def disable_auto_sync(self) -> None:
        self._set_auto_sync(False)

    def get_terminal_theme(self) -> TerminalTheme:
        return self._terminal_theme

    def _apply_theme_name(self, theme_name: str, show_error: bool = False) -> dict[str, Any]:
        result = set_theme(theme_name, enable_watcher=True)
        self._active_theme_name = theme_name if result.get("success") else "dark"
        self._notify_changed()
        if not result.get("success") and show_error:
            self._show_error(
                f'Failed to load theme "{theme_name}": {result.get("error")}\n'
                "Fell back to dark theme."
            )
        return result

    def _notify_changed(self) -> None:
        self._ui.invalidate()
        self._on_changed()

    def _set_auto_sync(self, enabled: bool) -> None:
        if self._auto_sync_enabled == enabled:
            return
        self._auto_sync_enabled = enabled
        self._ui.set_terminal_color_scheme_notifications(enabled)

    async def _detect_terminal_theme_for_auto(self) -> TerminalTheme:
        try:
            color_scheme: TerminalColorScheme | None = await self._ui.query_terminal_color_scheme(
                timeout_ms=100
            )
            if color_scheme is not None:
                return color_scheme
        except Exception:
            pass
        detection = await detect_terminal_background_theme(ui=self._ui, timeout_ms=100)
        return detection["theme"]

    def _apply_terminal_theme(self, terminal_theme: TerminalTheme) -> None:
        if not self._auto_sync_enabled:
            return
        self._terminal_theme = terminal_theme
        auto_theme = parse_auto_theme_setting(self._settings_manager.get_theme_setting())
        if not auto_theme:
            self._set_auto_sync(False)
            return
        theme_name = (
            auto_theme["lightTheme"] if terminal_theme == "light" else auto_theme["darkTheme"]
        )
        if theme_name != self._active_theme_name:
            self._apply_theme_name(theme_name)
