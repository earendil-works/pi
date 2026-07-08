"""Loader wrapped with borders for extension UI."""

from __future__ import annotations

from typing import Callable

from pi_mono.coding_agent.modes.interactive.theme.theme import Theme, theme
from pi_mono.tui.components.cancellable_loader import CancellableLoader
from pi_mono.tui.components.loader import Loader
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container, TUI
from pi_mono.utils.abort_signals import AbortController


class _BorderLine(Text):
    def render(self, width: int) -> list[str]:
        border_char = "─"
        return [self._color_fn(border_char * max(1, width))]

    def __init__(self, color_fn: Callable[[str], str]) -> None:
        super().__init__("", padding_x=0, padding_y=0)
        self._color_fn = color_fn


class BorderedLoader(Container):
    """Loader wrapped with top and bottom borders."""

    def __init__(
        self,
        ui: TUI,
        active_theme: Theme,
        message: str,
        *,
        cancellable: bool = True,
    ) -> None:
        super().__init__()
        self._cancellable = cancellable
        self._signal_controller = AbortController()
        border_color = active_theme.fg_fn("border")
        self.add_child(_BorderLine(border_color))
        if cancellable:
            self._loader: CancellableLoader | Loader = CancellableLoader(
                ui,
                active_theme.fg_fn("accent"),
                active_theme.fg_fn("muted"),
                message,
            )
        else:
            self._loader = Loader(
                ui,
                active_theme.fg_fn("accent"),
                active_theme.fg_fn("muted"),
                message,
            )
        self.add_child(self._loader)
        if cancellable:
            self.add_child(Spacer(1))
            self.add_child(Text(theme.fg("muted", "Esc to cancel"), padding_x=1, padding_y=0))
        self.add_child(Spacer(1))
        self.add_child(_BorderLine(border_color))

    @property
    def signal(self):
        if self._cancellable:
            return self._loader.signal  # type: ignore[union-attr]
        return self._signal_controller.signal  # type: ignore[union-attr]

    def set_on_abort(self, fn: Callable[[], None] | None) -> None:
        if self._cancellable:
            self._loader.on_abort = fn  # type: ignore[union-attr]

    def handle_input(self, data: str) -> None:
        if self._cancellable and hasattr(self._loader, "handle_input"):
            self._loader.handle_input(data)  # type: ignore[union-attr]

    def dispose(self) -> None:
        if hasattr(self._loader, "dispose"):
            self._loader.dispose()  # type: ignore[union-attr]
        elif hasattr(self._loader, "stop"):
            self._loader.stop()  # type: ignore[union-attr]
