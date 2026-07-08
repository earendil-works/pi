"""Scoped models selector for Ctrl+P model cycling."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pi_mono.ai.types import Model
from pi_mono.coding_agent.modes.interactive.model_search import get_model_search_text
from pi_mono.coding_agent.modes.interactive.theme.theme import get_editor_theme, theme
from pi_mono.tui.components.input import Input
from pi_mono.tui.components.select_list import SelectItem, SelectList
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.fuzzy import fuzzy_filter
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container, TUI


def _model_id(model: Model[Any]) -> str:
    return f"{model.get('provider', '')}/{model.get('id', '')}"


def _toggle_enabled(
    enabled_ids: list[str] | None, model_id: str, all_ids: list[str]
) -> list[str] | None:
    if enabled_ids is None:
        return [model_id]
    if model_id in enabled_ids:
        updated = [item for item in enabled_ids if item != model_id]
        return None if len(updated) == len(all_ids) else updated
    return [*enabled_ids, model_id]


def _move_enabled(enabled_ids: list[str], model_id: str, delta: int) -> list[str]:
    index = enabled_ids.index(model_id)
    new_index = index + delta
    if new_index < 0 or new_index >= len(enabled_ids):
        return enabled_ids
    result = list(enabled_ids)
    result[index], result[new_index] = result[new_index], result[index]
    return result


class _ModelSearchAdapter:
    def __init__(self, model: Model[Any]) -> None:
        self.id = str(model.get("id", ""))
        self.provider = str(model.get("provider", ""))
        name = model.get("name")
        self.name = str(name) if name else None


class ScopedModelsSelectorComponent(Container):
    def __init__(
        self,
        ui: TUI,
        all_models: list[Model[Any]],
        enabled_model_ids: list[str] | None,
        on_change: Callable[[list[str] | None], None],
        on_persist: Callable[[list[str] | None], None],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__()
        self._ui = ui
        self._all_models = all_models
        self._all_ids = [_model_id(model) for model in all_models]
        self._enabled_ids = list(enabled_model_ids) if enabled_model_ids is not None else None
        self._on_change = on_change
        self._on_persist = on_persist
        self._on_cancel = on_cancel
        self._filtered_models = list(all_models)
        self._selected_index = 0

        self.add_child(Text(theme.fg("accent", "Scoped models"), padding_x=1, padding_y=0))
        self.add_child(
            Text(
                theme.fg("muted", "Space toggles · Ctrl+S saves to settings"),
                padding_x=1,
                padding_y=0,
            )
        )
        self.add_child(Spacer(1))
        self._search_input = Input()
        self._search_input.on_submit = self._filter_models
        self.add_child(self._search_input)
        self.add_child(Spacer(1))
        self._select_list = SelectList([], 14, get_editor_theme().select_list)
        self._select_list.on_select = self._handle_select
        self._select_list.on_cancel = on_cancel
        self.add_child(self._select_list)
        self._update_list()

    @property
    def focused(self) -> bool:
        return self._search_input.focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._search_input.focused = value

    def _is_enabled(self, model_id: str) -> bool:
        return self._enabled_ids is None or model_id in self._enabled_ids

    def _update_list(self) -> None:
        items: list[SelectItem] = []
        for model in self._filtered_models:
            model_id = _model_id(model)
            checkbox = "[x]" if self._is_enabled(model_id) else "[ ]"
            items.append(
                SelectItem(
                    value=model_id,
                    label=f"{checkbox} {model_id}",
                )
            )
        self._select_list._items = items  # noqa: SLF001
        self._select_list._filtered_items = list(items)  # noqa: SLF001
        if items:
            self._selected_index = min(self._selected_index, len(items) - 1)
        else:
            self._selected_index = 0
        self._select_list.set_selected_index(self._selected_index)
        self._ui.request_render()

    def _filter_models(self, query: str = "") -> None:
        query = query.strip()
        if not query:
            self._filtered_models = list(self._all_models)
        else:
            self._filtered_models = fuzzy_filter(
                self._all_models,
                query,
                lambda model: get_model_search_text(_ModelSearchAdapter(model)),
            )
        self._update_list()

    def _handle_select(self, item: SelectItem) -> None:
        self._enabled_ids = _toggle_enabled(self._enabled_ids, str(item.value), self._all_ids)
        self._on_change(self._enabled_ids)
        self._update_list()

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()

        if kb.matches(data, "tui.select.up"):
            if self._filtered_models:
                self._selected_index = (
                    len(self._filtered_models) - 1
                    if self._selected_index == 0
                    else self._selected_index - 1
                )
                self._select_list.set_selected_index(self._selected_index)
                self._ui.request_render()
            return
        if kb.matches(data, "tui.select.down"):
            if self._filtered_models:
                self._selected_index = (
                    0
                    if self._selected_index == len(self._filtered_models) - 1
                    else self._selected_index + 1
                )
                self._select_list.set_selected_index(self._selected_index)
                self._ui.request_render()
            return
        if kb.matches(data, "tui.select.confirm"):
            selected = self._select_list.get_selected_item()
            if selected is not None:
                self._handle_select(selected)
            return
        if kb.matches(data, "tui.select.cancel"):
            self._on_cancel()
            return
        if kb.matches(data, "app.models.save"):
            self._on_persist(self._enabled_ids)
            return
        if self._enabled_ids is not None and (
            kb.matches(data, "app.models.reorderUp") or kb.matches(data, "app.models.reorderDown")
        ):
            selected = self._select_list.get_selected_item()
            if selected is not None:
                delta = -1 if kb.matches(data, "app.models.reorderUp") else 1
                self._enabled_ids = _move_enabled(self._enabled_ids, str(selected.value), delta)
                self._on_change(self._enabled_ids)
                self._selected_index = max(
                    0, min(len(self._filtered_models) - 1, self._selected_index + delta)
                )
                self._update_list()
            return
        if data == " ":
            selected = self._select_list.get_selected_item()
            if selected is not None:
                self._handle_select(selected)
            return
        self._search_input.handle_input(data)
        self._filter_models(self._search_input.get_value())
