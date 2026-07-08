"""First-time setup dialog."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from pi_mono.config import APP_NAME
from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import (
    key_hint,
    raw_key_hint,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container

THEME_OPTIONS = ("dark", "light")
ANALYTICS_OPTIONS = (True, False)


@dataclass
class FirstTimeSetupResult:
    theme: str
    share_analytics: bool


class FirstTimeSetupComponent(Container):
    def __init__(
        self,
        *,
        detected_theme: str,
        on_theme_preview: Callable[[str], None],
        on_submit: Callable[[FirstTimeSetupResult], None],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__()
        self._step = "theme"
        self._theme_index = max(
            0, THEME_OPTIONS.index(detected_theme) if detected_theme in THEME_OPTIONS else 0
        )
        self._analytics_index = 0
        self._on_theme_preview = on_theme_preview
        self._on_submit = on_submit
        self._on_cancel = on_cancel
        self._list_container = Container()
        self._update()

    def _update(self) -> None:
        self.clear()
        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", theme.bold(f"Welcome to {APP_NAME}")), 1, 0))
        self.add_child(Spacer(1))
        if self._step == "theme":
            self.add_child(Text("Pick a theme.", 1, 0))
            options = list(THEME_OPTIONS)
            selected = self._theme_index
        else:
            self.add_child(Text("Share anonymous usage data?", 1, 0))
            options = ["Share anonymous usage data", "Don't share"]
            selected = self._analytics_index
        self._list_container.clear()
        for index, label in enumerate(options):
            prefix = theme.fg("accent", "→ ") if index == selected else "  "
            text = theme.fg("accent", label) if index == selected else theme.fg("text", label)
            self._list_container.add_child(Text(f"{prefix}{text}", 1, 0))
        self.add_child(self._list_container)
        self.add_child(Spacer(1))
        self.add_child(
            Text(
                raw_key_hint("↑↓", "navigate")
                + "  "
                + key_hint("tui.select.confirm", "continue")
                + "  "
                + key_hint("tui.select.cancel", "skip"),
                1,
                0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())

    def handle_input(self, key_data: str) -> None:
        kb = get_keybindings()
        options_count = len(THEME_OPTIONS) if self._step == "theme" else len(ANALYTICS_OPTIONS)
        selected_index = self._theme_index if self._step == "theme" else self._analytics_index
        if kb.matches(key_data, "tui.select.up") or key_data == "k":
            selected_index = max(0, selected_index - 1)
        elif kb.matches(key_data, "tui.select.down") or key_data == "j":
            selected_index = min(options_count - 1, selected_index + 1)
        elif kb.matches(key_data, "tui.select.confirm") or key_data == "\n":
            if self._step == "theme":
                self._theme_index = selected_index
                self._on_theme_preview(THEME_OPTIONS[self._theme_index])
                self._step = "analytics"
                self._update()
                return
            self._analytics_index = selected_index
            self._on_submit(
                FirstTimeSetupResult(
                    theme=THEME_OPTIONS[self._theme_index],
                    share_analytics=ANALYTICS_OPTIONS[self._analytics_index],
                )
            )
            return
        elif kb.matches(key_data, "tui.select.cancel"):
            self._on_cancel()
            return
        else:
            return
        if self._step == "theme":
            self._theme_index = selected_index
            self._on_theme_preview(THEME_OPTIONS[self._theme_index])
        else:
            self._analytics_index = selected_index
        self._update()
