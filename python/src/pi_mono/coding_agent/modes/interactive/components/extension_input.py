"""Simple text input component for extensions."""

from __future__ import annotations

from collections.abc import Callable

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import (
    key_hint,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.input import Input
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container


class ExtensionInputComponent(Container):
    def __init__(
        self,
        title: str,
        on_submit: Callable[[str], None],
        on_cancel: Callable[[], None],
        *,
        placeholder: str | None = None,
    ) -> None:
        super().__init__()
        self._on_submit = on_submit
        self._on_cancel = on_cancel
        self._focused = False

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", title), padding_x=1, padding_y=0))
        self.add_child(Spacer(1))

        self._input = Input()
        if placeholder:
            self._input.set_value(placeholder)
        self.add_child(self._input)
        self.add_child(Spacer(1))
        self.add_child(
            Text(
                f"{key_hint('tui.select.confirm', 'submit')}  {key_hint('tui.select.cancel', 'cancel')}",
                padding_x=1,
                padding_y=0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())

    @property
    def focused(self) -> bool:
        return self._focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._focused = value
        self._input.focused = value

    def handle_input(self, key_data: str) -> None:
        kb = get_keybindings()
        if kb.matches(key_data, "tui.select.confirm") or key_data == "\n":
            self._on_submit(self._input.get_value())
            return
        if kb.matches(key_data, "tui.select.cancel"):
            self._on_cancel()
            return
        self._input.handle_input(key_data)
