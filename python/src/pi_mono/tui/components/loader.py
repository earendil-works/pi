"""Loader component that updates with an optional spinning animation"""

import asyncio
from typing import List, Optional, Callable

from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import TUI

DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
DEFAULT_INTERVAL_MS = 80


class LoaderIndicatorOptions:
    """Options for loader indicator animation"""

    def __init__(
        self,
        frames: Optional[List[str]] = None,
        interval_ms: Optional[int] = None,
    ) -> None:
        self.frames = frames
        self.interval_ms = interval_ms


class Loader(Text):
    """Loader component that updates with an optional spinning animation"""

    def __init__(
        self,
        ui: TUI,
        spinner_color_fn: Callable[[str], str],
        message_color_fn: Callable[[str], str],
        message: str = "Loading...",
        indicator: Optional[LoaderIndicatorOptions] = None,
    ) -> None:
        super().__init__("", 1, 0)
        self._frames = list(DEFAULT_FRAMES)
        self._interval_ms = DEFAULT_INTERVAL_MS
        self._current_frame = 0
        self._interval_task: Optional[asyncio.Task] = None
        self._ui = ui
        self._render_indicator_verbatim = False
        self._spinner_color_fn = spinner_color_fn
        self._message_color_fn = message_color_fn
        self._message = message
        self.set_indicator(indicator)

    def render(self, width: int) -> List[str]:
        return ["", *super().render(width)]

    def start(self) -> None:
        self._update_display()
        self._restart_animation()

    def stop(self) -> None:
        if self._interval_task:
            self._interval_task.cancel()
            self._interval_task = None

    def set_message(self, message: str) -> None:
        self._message = message
        self._update_display()

    def set_indicator(self, indicator: Optional[LoaderIndicatorOptions]) -> None:
        self._render_indicator_verbatim = indicator is not None
        if indicator and indicator.frames is not None:
            self._frames = list(indicator.frames)
        else:
            self._frames = list(DEFAULT_FRAMES)

        self._interval_ms = (
            indicator.interval_ms
            if indicator and indicator.interval_ms and indicator.interval_ms > 0
            else DEFAULT_INTERVAL_MS
        )
        self._current_frame = 0
        self.start()

    def _restart_animation(self) -> None:
        self.stop()
        if len(self._frames) <= 1:
            return

        async def _animate() -> None:
            while True:
                await asyncio.sleep(self._interval_ms / 1000.0)
                self._current_frame = (self._current_frame + 1) % len(self._frames)
                self._update_display()

        self._interval_task = asyncio.create_task(_animate())

    def _update_display(self) -> None:
        frame = self._frames[self._current_frame] if self._frames else ""
        rendered_frame = frame if self._render_indicator_verbatim else self._spinner_color_fn(frame)
        indicator = f"{rendered_frame} " if len(frame) > 0 else ""
        self.set_text(f"{indicator}{self._message_color_fn(self._message)}")
        if self._ui:
            self._ui.request_render()

    def handle_input(self, data: str) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False
