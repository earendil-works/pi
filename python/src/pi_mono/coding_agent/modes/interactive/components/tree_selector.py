"""Simplified session branch selector for interactive mode."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import (
    key_hint,
    raw_key_hint,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import get_editor_theme, theme
from pi_mono.tui.components.input import Input
from pi_mono.tui.components.select_list import SelectItem, SelectList
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.fuzzy import fuzzy_filter
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container, TUI

_NAVIGABLE_TYPES = frozenset({"message", "compaction", "branch_summary"})
TreeFilterMode = Literal["default", "no-tools", "user-only", "labeled-only", "all"]
_TREE_FILTER_MODES: tuple[TreeFilterMode, ...] = (
    "default",
    "no-tools",
    "user-only",
    "labeled-only",
    "all",
)


@dataclass(frozen=True)
class BranchListItem:
    entry_id: str
    label: str
    description: str
    entry_type: str
    is_current_leaf: bool


def _extract_message_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text", "")
            if isinstance(text, str) and text:
                parts.append(text)
    return "\n".join(parts)


def format_branch_entry_label(entry: dict[str, Any], label: str | None = None) -> str:
    entry_type = str(entry.get("type", ""))
    if entry_type == "compaction":
        return label or "compaction"
    if entry_type == "branch_summary":
        summary = entry.get("summary")
        if isinstance(summary, str) and summary.strip():
            return label or summary.strip()
        return label or "branch summary"
    if entry_type == "message":
        message = entry.get("message") or {}
        role = str(message.get("role", "message"))
        text = _extract_message_text(message.get("content"))
        preview = " ".join(text.split())
        if len(preview) > 60:
            preview = preview[:57] + "..."
        base = f"{role}: {preview}" if preview else role
        return f"{label} ({base})" if label else base
    return label or entry_type


def flatten_branch_entries(
    branch: list[dict[str, Any]],
    *,
    labels_by_id: dict[str, str] | None = None,
    current_leaf_id: str | None = None,
) -> list[BranchListItem]:
    """Flatten a session branch path into navigable list items."""
    labels = labels_by_id or {}
    items: list[BranchListItem] = []
    for entry in branch:
        entry_type = str(entry.get("type", ""))
        if entry_type not in _NAVIGABLE_TYPES:
            continue
        if entry_type == "message":
            role = (entry.get("message") or {}).get("role")
            if role not in ("user", "assistant"):
                continue
        entry_id = str(entry.get("id", ""))
        if not entry_id:
            continue
        label = labels.get(entry_id)
        display = format_branch_entry_label(entry, label)
        description = entry_type
        if entry_type == "message":
            description = str((entry.get("message") or {}).get("role", "message"))
        items.append(
            BranchListItem(
                entry_id=entry_id,
                label=display,
                description=description,
                entry_type=entry_type,
                is_current_leaf=entry_id == current_leaf_id,
            )
        )
    return items


def apply_tree_filter_mode(
    items: list[BranchListItem],
    mode: TreeFilterMode,
    *,
    labels_by_id: dict[str, str] | None = None,
) -> list[BranchListItem]:
    labels = labels_by_id or {}
    if mode == "default":
        return list(items)
    if mode == "user-only":
        return [item for item in items if item.description == "user"]
    if mode == "labeled-only":
        return [item for item in items if labels.get(item.entry_id)]
    if mode == "no-tools":
        return [
            item
            for item in items
            if item.entry_type != "message" or item.description != "toolResult"
        ]
    return list(items)


def filter_branch_entries(items: list[BranchListItem], query: str) -> list[BranchListItem]:
    """Filter branch list items by a search query."""
    trimmed = query.strip()
    if not trimmed:
        return list(items)
    return fuzzy_filter(
        items,
        trimmed,
        lambda item: f"{item.label} {item.description} {item.entry_type}",
    )


class TreeSelectorComponent(Container):
    """Flat branch list selector with search filter."""

    def __init__(
        self,
        ui: TUI,
        session_manager: Any,
        on_select: Callable[[str], None],
        on_cancel: Callable[[], None],
        *,
        initial_search: str | None = None,
        initial_filter_mode: TreeFilterMode = "default",
        on_filter_mode_change: Callable[[TreeFilterMode], None] | None = None,
    ) -> None:
        super().__init__()
        self._ui = ui
        self._session_manager = session_manager
        self._on_select = on_select
        self._on_cancel = on_cancel
        self._filter_mode = initial_filter_mode
        self._on_filter_mode_change = on_filter_mode_change
        self._labels_by_id: dict[str, str] = {}
        self._all_items: list[BranchListItem] = []
        self._filtered_items: list[BranchListItem] = []

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(
            Text(theme.fg("accent", theme.bold("Session branch")), padding_x=1, padding_y=0)
        )
        self.add_child(Spacer(1))

        self._search_input = Input()
        if initial_search:
            self._search_input.set_value(initial_search)
        self._search_input.on_submit = self._select_first_filtered
        self.add_child(self._search_input)
        self.add_child(Spacer(1))

        editor_theme = get_editor_theme()
        self._select_list = SelectList([], 12, editor_theme.select_list)
        self._select_list.on_select = self._handle_select_item
        self._select_list.on_cancel = on_cancel
        self.add_child(self._select_list)
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

        self._reload_items()
        if initial_search:
            self._apply_filter(initial_search)
        else:
            self._update_list()

    @property
    def focused(self) -> bool:
        return self._search_input.focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._search_input.focused = value

    def _reload_items(self) -> None:
        branch = self._session_manager.get_branch()
        self._labels_by_id = dict(getattr(self._session_manager, "labels_by_id", {}) or {})
        current_leaf_id = self._session_manager.get_leaf_id()
        items = flatten_branch_entries(
            branch,
            labels_by_id=self._labels_by_id,
            current_leaf_id=current_leaf_id,
        )
        self._all_items = apply_tree_filter_mode(
            items,
            self._filter_mode,
            labels_by_id=self._labels_by_id,
        )
        self._filtered_items = list(self._all_items)
        current_index = next(
            (index for index, item in enumerate(self._filtered_items) if item.is_current_leaf),
            max(0, len(self._filtered_items) - 1),
        )
        self._select_list.set_selected_index(current_index)

    def _apply_filter(self, query: str) -> None:
        self._filtered_items = filter_branch_entries(self._all_items, query)
        self._update_list()

    def _update_list(self) -> None:
        items: list[SelectItem] = []
        for item in self._filtered_items:
            label = item.label
            if item.is_current_leaf:
                label = f"{label} •"
            items.append(
                SelectItem(
                    value=item.entry_id,
                    label=label,
                    description=f"[{item.description}]",
                )
            )
        self._select_list._items = items  # noqa: SLF001
        self._select_list._filtered_items = list(items)  # noqa: SLF001
        self._select_list.set_selected_index(0)
        self._ui.request_render()

    def _select_first_filtered(self) -> None:
        selected = self._select_list.get_selected_item()
        if selected:
            self._on_select(selected.value)

    def _handle_select_item(self, item: SelectItem) -> None:
        self._on_select(item.value)

    def _set_filter_mode(self, mode: TreeFilterMode) -> None:
        self._filter_mode = mode
        if self._on_filter_mode_change is not None:
            self._on_filter_mode_change(mode)
        self._reload_items()
        self._apply_filter(self._search_input.get_value())

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()
        if kb.matches(data, "app.tree.filter.default"):
            self._set_filter_mode("default")
            return
        if kb.matches(data, "app.tree.filter.noTools"):
            self._set_filter_mode("default" if self._filter_mode == "no-tools" else "no-tools")
            return
        if kb.matches(data, "app.tree.filter.userOnly"):
            self._set_filter_mode("default" if self._filter_mode == "user-only" else "user-only")
            return
        if kb.matches(data, "app.tree.filter.labeledOnly"):
            self._set_filter_mode(
                "default" if self._filter_mode == "labeled-only" else "labeled-only"
            )
            return
        if kb.matches(data, "app.tree.filter.all"):
            self._set_filter_mode("default" if self._filter_mode == "all" else "all")
            return
        if kb.matches(data, "app.tree.filter.cycleForward"):
            current_index = _TREE_FILTER_MODES.index(self._filter_mode)
            self._set_filter_mode(_TREE_FILTER_MODES[(current_index + 1) % len(_TREE_FILTER_MODES)])
            return
        if kb.matches(data, "app.tree.filter.cycleBackward"):
            current_index = _TREE_FILTER_MODES.index(self._filter_mode)
            self._set_filter_mode(_TREE_FILTER_MODES[(current_index - 1) % len(_TREE_FILTER_MODES)])
            return
        if kb.matches(data, "tui.select.up") or kb.matches(data, "tui.select.down"):
            self._select_list.handle_input(data)
            return
        if kb.matches(data, "tui.select.confirm"):
            self._select_list.handle_input(data)
            return
        if kb.matches(data, "tui.select.cancel"):
            self._on_cancel()
            return
        self._search_input.handle_input(data)
        self._apply_filter(self._search_input.get_value())
