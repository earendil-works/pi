"""Thinking level selector overlay."""

from __future__ import annotations

from typing import Callable

from pi_mono.agent.types import AgentThinkingLevel
from pi_mono.coding_agent.modes.interactive.theme.theme import get_select_list_theme, theme
from pi_mono.tui.components.select_list import SelectItem, SelectList
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container

ThinkingLevel = AgentThinkingLevel

THINKING_DESCRIPTIONS: dict[ThinkingLevel, str] = {
    "off": "No reasoning",
    "minimal": "Very brief reasoning (~1k tokens)",
    "low": "Light reasoning (~2k tokens)",
    "medium": "Moderate reasoning (~8k tokens)",
    "high": "Deep reasoning (~16k tokens)",
    "xhigh": "Maximum reasoning (~32k tokens)",
}


class ThinkingSelectorComponent(Container):
    """Simple SelectList overlay for thinking levels."""

    def __init__(
        self,
        current_level: ThinkingLevel,
        available_levels: list[ThinkingLevel],
        on_select: Callable[[ThinkingLevel], None],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__()
        self.add_child(
            Text(theme.bold(theme.fg("accent", "Thinking Level")), padding_x=0, padding_y=0)
        )
        self.add_child(Spacer(1))

        items = [
            SelectItem(value=level, label=level, description=THINKING_DESCRIPTIONS[level])
            for level in available_levels
        ]
        self._select_list = SelectList(items, len(items), get_select_list_theme())
        current_index = next(
            (index for index, item in enumerate(items) if item.value == current_level), 0
        )
        self._select_list.set_selected_index(current_index)
        self._select_list.on_select = lambda item: on_select(item.value)  # type: ignore[arg-type]
        self._select_list.on_cancel = on_cancel
        self.add_child(self._select_list)

    def get_select_list(self) -> SelectList:
        return self._select_list

    def handle_input(self, data: str) -> None:
        self._select_list.handle_input(data)
