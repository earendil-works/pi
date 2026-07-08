"""SelectList component - list selection with filtering and keyboard navigation"""

from typing import List, Optional, Callable
from dataclasses import dataclass

from pi_mono.tui.utils import truncate_to_width, visible_width
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.editor_component import Component

DEFAULT_PRIMARY_COLUMN_WIDTH = 32
PRIMARY_COLUMN_GAP = 2
MIN_DESCRIPTION_WIDTH = 10


def _normalize_to_single_line(text: str) -> str:
    return text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ").strip()


def _clamp(value: int, min_val: int, max_val: int) -> int:
    return max(min_val, min(value, max_val))


@dataclass
class SelectItem:
    value: str
    label: str
    description: Optional[str] = None


@dataclass
class SelectListTheme:
    selected_prefix: Callable[[str], str]
    selected_text: Callable[[str], str]
    description: Callable[[str], str]
    scroll_info: Callable[[str], str]
    no_match: Callable[[str], str]


@dataclass
class SelectListLayoutOptions:
    min_primary_column_width: Optional[int] = None
    max_primary_column_width: Optional[int] = None
    truncate_primary: Optional[Callable] = None


class SelectList(Component):
    """SelectList component - list selection with filtering and keyboard navigation"""

    def __init__(
        self,
        items: List[SelectItem],
        max_visible: int,
        theme: SelectListTheme,
        layout: Optional[SelectListLayoutOptions] = None,
    ) -> None:
        self._items = items
        self._filtered_items = list(items)
        self._selected_index = 0
        self._max_visible = max_visible
        self._theme = theme
        self._layout = layout or SelectListLayoutOptions()

        self.on_select: Optional[Callable[[SelectItem], None]] = None
        self.on_cancel: Optional[Callable[[], None]] = None
        self.on_selection_change: Optional[Callable[[SelectItem], None]] = None

    def set_filter(self, filter_text: str) -> None:
        if not filter_text:
            self._filtered_items = list(self._items)
        else:
            filter_lower = filter_text.lower()
            self._filtered_items = [
                item
                for item in self._items
                if item.value.lower().startswith(filter_lower)
                or item.label.lower().startswith(filter_lower)
            ]
        # Reset selection when filter changes
        self._selected_index = 0

    def set_selected_index(self, index: int) -> None:
        if not self._filtered_items:
            self._selected_index = 0
        else:
            self._selected_index = _clamp(index, 0, len(self._filtered_items) - 1)

    def invalidate(self) -> None:
        pass

    def render(self, width: int) -> List[str]:
        lines: List[str] = []

        # If no items match filter, show message
        if not self._filtered_items:
            lines.append(self._theme.no_match("  No matching commands"))
            return lines

        primary_column_width = self._get_primary_column_width()

        # Calculate visible range with scrolling
        start_index = max(
            0,
            min(
                self._selected_index - self._max_visible // 2,
                len(self._filtered_items) - self._max_visible,
            ),
        )
        end_index = min(start_index + self._max_visible, len(self._filtered_items))

        # Render visible items
        for i in range(start_index, end_index):
            item = self._filtered_items[i]
            if not item:
                continue

            is_selected = i == self._selected_index
            description_single_line = (
                _normalize_to_single_line(item.description) if item.description else None
            )
            lines.append(
                self._render_item(
                    item, is_selected, width, description_single_line, primary_column_width
                )
            )

        # Add scroll indicators if needed
        if start_index > 0 or end_index < len(self._filtered_items):
            scroll_text = f"  ({self._selected_index + 1}/{len(self._filtered_items)})"
            truncated_scroll = truncate_to_width(scroll_text, width - 2, "")
            lines.append(self._theme.scroll_info(truncated_scroll))

        return lines

    def handle_input(self, key_data: str) -> None:
        kb = get_keybindings()
        # Up arrow - wrap to bottom when at top
        if kb.matches(key_data, "tui.select.up"):
            if self._selected_index == 0:
                self._selected_index = len(self._filtered_items) - 1
            else:
                self._selected_index -= 1
            self._notify_selection_change()
        # Down arrow - wrap to top when at bottom
        elif kb.matches(key_data, "tui.select.down"):
            if self._selected_index == len(self._filtered_items) - 1:
                self._selected_index = 0
            else:
                self._selected_index += 1
            self._notify_selection_change()
        # Enter
        elif kb.matches(key_data, "tui.select.confirm"):
            selected_item = self._get_selected_item()
            if selected_item and self.on_select:
                self.on_select(selected_item)
        # Escape or Ctrl+C
        elif kb.matches(key_data, "tui.select.cancel"):
            if self.on_cancel:
                self.on_cancel()

    def _render_item(
        self,
        item: SelectItem,
        is_selected: bool,
        width: int,
        description_single_line: Optional[str],
        primary_column_width: int,
    ) -> str:
        prefix = "→ " if is_selected else "  "
        prefix_width = visible_width(prefix)

        if description_single_line and width > 40:
            effective_primary_column_width = max(
                1, min(primary_column_width, width - prefix_width - 4)
            )
            max_primary_width = max(1, effective_primary_column_width - PRIMARY_COLUMN_GAP)
            truncated_value = self._truncate_primary(
                item, is_selected, max_primary_width, effective_primary_column_width
            )
            truncated_value_width = visible_width(truncated_value)
            spacing = " " * max(1, effective_primary_column_width - truncated_value_width)
            description_start = prefix_width + truncated_value_width + len(spacing)
            remaining_width = width - description_start - 2  # -2 for safety

            if remaining_width > MIN_DESCRIPTION_WIDTH:
                truncated_desc = truncate_to_width(description_single_line, remaining_width, "")
                if is_selected:
                    return self._theme.selected_text(
                        f"{prefix}{truncated_value}{spacing}{truncated_desc}"
                    )

                desc_text = self._theme.description(spacing + truncated_desc)
                return prefix + truncated_value + desc_text

        max_width = width - prefix_width - 2
        truncated_value = self._truncate_primary(item, is_selected, max_width, max_width)
        if is_selected:
            return self._theme.selected_text(f"{prefix}{truncated_value}")

        return prefix + truncated_value

    def _get_primary_column_bounds(self) -> tuple[int, int]:
        raw_min = (
            self._layout.min_primary_column_width
            or self._layout.max_primary_column_width
            or DEFAULT_PRIMARY_COLUMN_WIDTH
        )
        raw_max = (
            self._layout.max_primary_column_width
            or self._layout.min_primary_column_width
            or DEFAULT_PRIMARY_COLUMN_WIDTH
        )

        return (
            max(1, min(raw_min, raw_max)),
            max(1, max(raw_min, raw_max)),
        )

    def _get_primary_column_width(self) -> int:
        min_width, max_width = self._get_primary_column_bounds()
        widest_primary = 0
        for item in self._filtered_items:
            display_value = self._get_display_value(item)
            widest_primary = max(widest_primary, visible_width(display_value) + PRIMARY_COLUMN_GAP)

        return _clamp(widest_primary, min_width, max_width)

    def _truncate_primary(
        self, item: SelectItem, is_selected: bool, max_width: int, column_width: int
    ) -> str:
        display_value = self._get_display_value(item)
        truncated_value = (
            self._layout.truncate_primary(
                {
                    "text": display_value,
                    "maxWidth": max_width,
                    "columnWidth": column_width,
                    "item": item,
                    "isSelected": is_selected,
                }
            )
            if self._layout.truncate_primary
            else truncate_to_width(display_value, max_width, "")
        )

        return truncate_to_width(truncated_value, max_width, "")

    def _get_display_value(self, item: SelectItem) -> str:
        return item.label or item.value

    def _notify_selection_change(self) -> None:
        selected_item = self._get_selected_item()
        if selected_item and self.on_selection_change:
            self.on_selection_change(selected_item)

    def _get_selected_item(self) -> Optional[SelectItem]:
        if not self._filtered_items:
            return None
        return self._filtered_items[self._selected_index]

    def get_selected_item(self) -> Optional[SelectItem]:
        return self._get_selected_item()

    @property
    def wants_key_release(self) -> bool:
        return False
