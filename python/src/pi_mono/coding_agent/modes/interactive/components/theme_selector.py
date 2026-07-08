"""Standalone theme selector."""

from __future__ import annotations

from collections.abc import Callable

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import (
    key_hint,
    raw_key_hint,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import get_available_themes, theme
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container


class ThemeSelectorComponent(Container):
    def __init__(
        self,
        current_theme: str,
        *,
        on_select: Callable[[str], None],
        on_cancel: Callable[[], None],
        on_preview: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__()
        self._themes = get_available_themes()
        self._on_select = on_select
        self._on_cancel = on_cancel
        self._on_preview = on_preview
        self._selected_index = max(
            0, self._themes.index(current_theme) if current_theme in self._themes else 0
        )

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", theme.bold("Theme")), 1, 0))
        self.add_child(Spacer(1))
        self._list_container = Container()
        self.add_child(self._list_container)
        self.add_child(Spacer(1))
        self.add_child(
            Text(
                raw_key_hint("↑↓", "navigate")
                + "  "
                + key_hint("tui.select.confirm", "select")
                + "  "
                + key_hint("tui.select.cancel", "cancel"),
                1,
                0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())
        self._update_list()

    def _update_list(self) -> None:
        self._list_container.clear()
        for index, name in enumerate(self._themes):
            prefix = theme.fg("accent", "→ ") if index == self._selected_index else "  "
            label = (
                theme.fg("accent", name)
                if index == self._selected_index
                else theme.fg("text", name)
            )
            self._list_container.add_child(Text(f"{prefix}{label}", 1, 0))

    def handle_input(self, key_data: str) -> None:
        kb = get_keybindings()
        if kb.matches(key_data, "tui.select.up") or key_data == "k":
            self._selected_index = max(0, self._selected_index - 1)
            self._update_list()
            if self._on_preview is not None:
                self._on_preview(self._themes[self._selected_index])
            return
        if kb.matches(key_data, "tui.select.down") or key_data == "j":
            self._selected_index = min(len(self._themes) - 1, self._selected_index + 1)
            self._update_list()
            if self._on_preview is not None:
                self._on_preview(self._themes[self._selected_index])
            return
        if kb.matches(key_data, "tui.select.confirm") or key_data == "\n":
            self._on_select(self._themes[self._selected_index])
            return
        if kb.matches(key_data, "tui.select.cancel"):
            self._on_cancel()
