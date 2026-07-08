"""Model selector for interactive mode."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Literal

from pi_mono.ai.models import models_are_equal
from pi_mono.ai.types import Model
from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.model_search import get_model_selector_search_text
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.tui.components.input import Input
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.fuzzy import fuzzy_filter
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container, TUI

ModelScope = Literal["all", "scoped"]
_MAX_VISIBLE = 10


class _ModelSearchAdapter:
    def __init__(self, model: Model[Any]) -> None:
        self.id = str(model.get("id", ""))
        self.provider = str(model.get("provider", ""))
        name = model.get("name")
        self.name = str(name) if name else None


class ModelSelectorComponent(Container):
    """Scrollable model selector with search (TS parity)."""

    def __init__(
        self,
        ui: TUI,
        current_model: Model[Any] | None,
        settings_manager: SettingsManager,
        model_registry: ModelRegistry,
        on_select: Callable[[Model[Any]], None],
        on_cancel: Callable[[], None],
        *,
        scoped_models: list[dict[str, Any]] | None = None,
        initial_search: str | None = None,
    ) -> None:
        super().__init__()
        self._ui = ui
        self._current_model = current_model
        self._settings_manager = settings_manager
        self._model_registry = model_registry
        self._on_select = on_select
        self._on_cancel = on_cancel
        self._scoped_models = list(scoped_models or [])
        self._scope: ModelScope = "scoped" if self._scoped_models else "all"
        self._all_models: list[Model[Any]] = []
        self._scoped_model_items: list[Model[Any]] = []
        self._active_models: list[Model[Any]] = []
        self._filtered_models: list[Model[Any]] = []
        self._selected_index = 0
        self._error_message: str | None = None
        self._scope_text: Text | None = None
        self._loading = True
        self._initial_search = initial_search

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", "Select model"), padding_x=1, padding_y=0))
        self.add_child(Spacer(1))

        if self._scoped_models:
            self._scope_text = Text(self._get_scope_text(), padding_x=1, padding_y=0)
            self.add_child(self._scope_text)
            self.add_child(
                Text(
                    theme.fg("muted", "Tab: scope (all/scoped)"),
                    padding_x=1,
                    padding_y=0,
                )
            )
            self.add_child(Spacer(1))
        else:
            self.add_child(
                Text(
                    theme.fg(
                        "warning",
                        "Only showing models from configured providers. Use /login to add providers.",
                    ),
                    padding_x=1,
                    padding_y=0,
                )
            )
            self.add_child(Spacer(1))

        self._search_input = Input()
        if initial_search:
            self._search_input.set_value(initial_search)
        self._search_input.on_submit = self._select_current
        self.add_child(self._search_input)
        self.add_child(Spacer(1))

        self._list_container = Container()
        self.add_child(self._list_container)
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())

        self._update_list()
        self._schedule_load_models()

    def _schedule_load_models(self) -> None:
        try:
            asyncio.get_running_loop().create_task(self._load_models_async())
        except RuntimeError:
            self._load_models()
            self._loading = False
            if self._initial_search:
                self._filter_models(self._initial_search)
            else:
                self._update_list()

    async def _load_models_async(self) -> None:
        try:
            await asyncio.to_thread(self._model_registry.refresh)
            self._load_models()
        except Exception as error:
            self._all_models = []
            self._scoped_model_items = []
            self._active_models = []
            self._filtered_models = []
            self._error_message = str(error)
        finally:
            self._loading = False
            if self._initial_search:
                self._filter_models(self._initial_search)
            else:
                self._update_list()
            self._ui.request_render()

    @property
    def focused(self) -> bool:
        return self._search_input.focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._search_input.focused = value

    def _get_scope_text(self) -> str:
        all_text = theme.fg("accent", "all") if self._scope == "all" else theme.fg("muted", "all")
        scoped_text = (
            theme.fg("accent", "scoped") if self._scope == "scoped" else theme.fg("muted", "scoped")
        )
        return f"{theme.fg('muted', 'Scope: ')}{all_text}{theme.fg('muted', ' | ')}{scoped_text}"

    def _set_scope(self, scope: ModelScope) -> None:
        if self._scope == scope:
            return
        self._scope = scope
        self._active_models = (
            self._scoped_model_items if self._scope == "scoped" else self._all_models
        )
        current_index = next(
            (
                index
                for index, model in enumerate(self._active_models)
                if models_are_equal(self._current_model, model)
            ),
            0,
        )
        self._selected_index = current_index
        if self._scope_text is not None:
            self._scope_text.set_text(self._get_scope_text())
        self._filter_models(self._search_input.get_value())

    def _load_models(self) -> None:
        self._error_message = self._model_registry.get_error()
        try:
            self._all_models = self._sort_models(self._model_registry.get_available())
        except Exception as error:
            self._all_models = []
            self._scoped_model_items = []
            self._active_models = []
            self._filtered_models = []
            self._error_message = str(error)
            return

        self._scoped_model_items = []
        for scoped in self._scoped_models:
            model = scoped.get("model")
            if not isinstance(model, dict):
                continue
            refreshed = self._model_registry.find(
                str(model.get("provider", "")), str(model.get("id", ""))
            )
            candidate = refreshed or model
            if self._model_registry.has_configured_auth(candidate):
                self._scoped_model_items.append(candidate)

        if self._scope == "scoped" and not self._scoped_model_items:
            self._scope = "all"
            if self._scope_text is not None:
                self._scope_text.set_text(self._get_scope_text())

        self._active_models = (
            self._scoped_model_items if self._scope == "scoped" else self._all_models
        )
        self._filtered_models = list(self._active_models)
        current_index = next(
            (
                index
                for index, model in enumerate(self._filtered_models)
                if models_are_equal(self._current_model, model)
            ),
            0,
        )
        self._selected_index = current_index

    def _sort_models(self, models: list[Model[Any]]) -> list[Model[Any]]:
        return sorted(
            models,
            key=lambda model: (
                0 if models_are_equal(self._current_model, model) else 1,
                str(model.get("provider", "")),
                str(model.get("id", "")),
            ),
        )

    def _filter_models(self, query: str) -> None:
        if query.strip():
            self._filtered_models = fuzzy_filter(
                self._active_models,
                query,
                lambda model: get_model_selector_search_text(_ModelSearchAdapter(model)),
            )
        else:
            self._filtered_models = list(self._active_models)
        self._selected_index = min(
            self._selected_index, max(0, len(self._filtered_models) - 1)
        )
        self._update_list()

    def _update_list(self) -> None:
        self._list_container.clear()

        if self._loading:
            self._list_container.add_child(
                Text(theme.fg("muted", "  Loading models..."), padding_x=1, padding_y=0)
            )
            self._ui.request_render()
            return

        if self._error_message:
            for line in self._error_message.split("\n"):
                self._list_container.add_child(
                    Text(theme.fg("error", line), padding_x=1, padding_y=0)
                )
            self._ui.request_render()
            return

        if not self._filtered_models:
            if not self._all_models:
                self._list_container.add_child(
                    Text(
                        theme.fg(
                            "warning",
                            "No models available. Use /login to authenticate a provider (e.g. Cursor).",
                        ),
                        padding_x=1,
                        padding_y=0,
                    )
                )
            else:
                self._list_container.add_child(
                    Text(theme.fg("muted", "  No matching models"), padding_x=1, padding_y=0)
                )
            self._ui.request_render()
            return

        start_index = max(
            0,
            min(
                self._selected_index - _MAX_VISIBLE // 2,
                len(self._filtered_models) - _MAX_VISIBLE,
            ),
        )
        end_index = min(start_index + _MAX_VISIBLE, len(self._filtered_models))

        for index in range(start_index, end_index):
            model = self._filtered_models[index]
            is_selected = index == self._selected_index
            is_current = models_are_equal(self._current_model, model)
            model_id = str(model.get("id", ""))
            provider = str(model.get("provider", ""))
            provider_badge = theme.fg("muted", f"[{provider}]")
            checkmark = theme.fg("success", " ✓") if is_current else ""
            if is_selected:
                prefix = theme.fg("accent", "→ ")
                line = f"{prefix}{theme.fg('accent', model_id)} {provider_badge}{checkmark}"
            else:
                line = f"  {model_id} {provider_badge}{checkmark}"
            self._list_container.add_child(Text(line, padding_x=1, padding_y=0))

        if start_index > 0 or end_index < len(self._filtered_models):
            scroll_info = theme.fg(
                "muted", f"  ({self._selected_index + 1}/{len(self._filtered_models)})"
            )
            self._list_container.add_child(Text(scroll_info, padding_x=1, padding_y=0))

        selected = self._filtered_models[self._selected_index]
        model_name = selected.get("name") or selected.get("id", "")
        self._list_container.add_child(Spacer(1))
        self._list_container.add_child(
            Text(theme.fg("muted", f"  Model Name: {model_name}"), padding_x=1, padding_y=0)
        )
        self._ui.request_render()

    def _select_current(self) -> None:
        if not self._filtered_models:
            return
        model = self._filtered_models[self._selected_index]
        self._handle_select(model)

    def _handle_select(self, model: Model[Any]) -> None:
        self._settings_manager.set_default_model_and_provider(
            str(model.get("provider", "")),
            str(model.get("id", "")),
        )
        self._on_select(model)

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()
        if kb.matches(data, "tui.input.tab") and self._scoped_models:
            next_scope: ModelScope = "scoped" if self._scope == "all" else "all"
            self._set_scope(next_scope)
            return
        if kb.matches(data, "tui.select.up"):
            if not self._filtered_models:
                return
            self._selected_index = (
                len(self._filtered_models) - 1
                if self._selected_index == 0
                else self._selected_index - 1
            )
            self._update_list()
            return
        if kb.matches(data, "tui.select.down"):
            if not self._filtered_models:
                return
            self._selected_index = (
                0
                if self._selected_index == len(self._filtered_models) - 1
                else self._selected_index + 1
            )
            self._update_list()
            return
        if kb.matches(data, "tui.select.confirm"):
            self._select_current()
            return
        if kb.matches(data, "tui.select.cancel"):
            self._on_cancel()
            return
        self._search_input.handle_input(data)
        self._filter_models(self._search_input.get_value())
