"""Loader that can be cancelled with Escape"""

from typing import Callable, Optional

from pi_mono.utils.abort_signals import AbortController, AbortSignal
from pi_mono.tui.components.loader import Loader
from pi_mono.tui.keybindings import get_keybindings


class CancellableLoader(Loader):
    """Loader that can be cancelled with Escape.

    Extends Loader with an AbortSignal for cancelling async operations.
    """

    def __init__(
        self,
        ui,
        spinner_color_fn: Callable[[str], str],
        message_color_fn: Callable[[str], str],
        message: str = "Loading...",
        indicator: Optional[object] = None,
    ) -> None:
        super().__init__(ui, spinner_color_fn, message_color_fn, message, indicator)
        self._abort_controller = AbortController()
        self.on_abort: Optional[Callable[[], None]] = None

    @property
    def signal(self) -> AbortSignal:
        """AbortSignal that is aborted when user presses Escape"""
        return self._abort_controller.signal

    @property
    def aborted(self) -> bool:
        """Whether the loader was aborted"""
        return self._abort_controller.signal.aborted

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()
        if kb.matches(data, "tui.select.cancel"):
            self._abort_controller.abort()
            if self.on_abort:
                self.on_abort()

    def dispose(self) -> None:
        self.stop()
