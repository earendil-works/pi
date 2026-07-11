"""Simple text input component for extensions."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from pi_mono.coding_agent.modes.interactive.components.countdown_timer import CountdownTimer
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

if TYPE_CHECKING:
    from pi_mono.tui.tui import TUI


class ExtensionInputComponent(Container):
    def __init__(
        self,
        title: str,
        on_submit: Callable[[str], None],
        on_cancel: Callable[[], None],
        *,
        placeholder: str | None = None,
        opts: dict[str, Any] | None = None,
    ) -> None:
        super().__init__()
        del placeholder  # Match TS: placeholder is accepted but not prefilled
        self._on_submit = on_submit
        self._on_cancel = on_cancel
        self._focused = False
        self._base_title = title
        self._countdown: CountdownTimer | None = None

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self._title_text = Text(theme.fg("accent", title), padding_x=1, padding_y=0)
        self.add_child(self._title_text)
        self.add_child(Spacer(1))

        timeout_ms = (opts or {}).get("timeout")
        tui: TUI | None = (opts or {}).get("tui")
        if isinstance(timeout_ms, (int, float)) and timeout_ms > 0 and tui is not None:
            self._countdown = CountdownTimer(
                int(timeout_ms),
                tui,
                lambda seconds: self._title_text.set_text(
                    theme.fg("accent", f"{self._base_title} ({seconds}s)")
                ),
                self._on_cancel,
            )

        self._input = Input()
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

    def dispose(self) -> None:
        if self._countdown is not None:
            self._countdown.dispose()
            self._countdown = None

    def handle_input(self, key_data: str) -> None:
        kb = get_keybindings()
        if kb.matches(key_data, "tui.select.confirm") or key_data == "\n":
            self.dispose()
            self._on_submit(self._input.get_value())
            return
        if kb.matches(key_data, "tui.select.cancel"):
            self.dispose()
            self._on_cancel()
            return
        self._input.handle_input(key_data)
