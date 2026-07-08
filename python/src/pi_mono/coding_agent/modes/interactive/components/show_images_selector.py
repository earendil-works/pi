"""Show images selector overlay."""

from __future__ import annotations

from collections.abc import Callable

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.theme.theme import get_select_list_theme
from pi_mono.tui.components.select_list import SelectItem, SelectList, SelectListLayoutOptions
from pi_mono.tui.tui import Container

SHOW_IMAGES_SELECT_LIST_LAYOUT = SelectListLayoutOptions(
    min_primary_column_width=12,
    max_primary_column_width=32,
)


class ShowImagesSelectorComponent(Container):
    def __init__(
        self,
        current_value: bool,
        on_select: Callable[[bool], None],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__()
        items = [
            SelectItem(value="yes", label="Yes", description="Show images inline in terminal"),
            SelectItem(value="no", label="No", description="Show text placeholder instead"),
        ]
        self.add_child(DynamicBorder())
        self._select_list = SelectList(
            items,
            5,
            get_select_list_theme(),
            SHOW_IMAGES_SELECT_LIST_LAYOUT,
        )
        self._select_list.set_selected_index(0 if current_value else 1)
        self._select_list.on_select = lambda item: on_select(item.value == "yes")
        self._select_list.on_cancel = on_cancel
        self.add_child(self._select_list)
        self.add_child(DynamicBorder())

    def get_select_list(self) -> SelectList:
        return self._select_list

    def handle_input(self, data: str) -> None:
        self._select_list.handle_input(data)
