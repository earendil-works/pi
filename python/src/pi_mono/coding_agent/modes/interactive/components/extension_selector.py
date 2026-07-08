"""Generic selector component for extension flags and paths."""

from __future__ import annotations

from collections.abc import Callable

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


class ExtensionSelectorComponent(Container):
    """SelectList-style overlay for extension-provided string options."""

    def __init__(
        self,
        title: str,
        options: list[str],
        on_select: Callable[[str], None],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__()
        self._options = options
        self._selected_index = 0
        self._on_select = on_select
        self._on_cancel = on_cancel

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", theme.bold(title)), padding_x=1, padding_y=0))
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
                padding_x=1,
                padding_y=0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())
        self._update_list()

    def _update_list(self) -> None:
        self._list_container.clear()
        for index, option in enumerate(self._options):
            if index == self._selected_index:
                line = theme.fg("accent", "→ ") + theme.fg("accent", option)
            else:
                line = f"  {theme.fg('text', option)}"
            self._list_container.add_child(Text(line, padding_x=1, padding_y=0))

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()
        if kb.matches(data, "tui.select.up") or data == "k":
            self._selected_index = max(0, self._selected_index - 1)
            self._update_list()
        elif kb.matches(data, "tui.select.down") or data == "j":
            self._selected_index = min(len(self._options) - 1, self._selected_index + 1)
            self._update_list()
        elif kb.matches(data, "tui.select.confirm") or data == "\n":
            if self._options:
                self._on_select(self._options[self._selected_index])
        elif kb.matches(data, "tui.select.cancel"):
            self._on_cancel()
