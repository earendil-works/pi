"""Dynamic horizontal border line that adjusts to viewport width."""

from __future__ import annotations

from collections.abc import Callable

from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.editor_component import Component


class DynamicBorder(Component):
    """Renders a horizontal border line using the theme border color."""

    def __init__(self, color: Callable[[str], str] | None = None) -> None:
        self._color = color or (lambda text: theme.fg("border", text))

    def invalidate(self) -> None:
        pass

    def render(self, width: int) -> list[str]:
        return [self._color("─" * max(1, width))]
