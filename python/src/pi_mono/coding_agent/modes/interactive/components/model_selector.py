"""Model selector for interactive mode — provider first, then models."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
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
SelectorStep = Literal["provider", "models"]
_MAX_VISIBLE = 10


class _ModelSearchAdapter:
    def __init__(self, model: Model[Any]) -> None:
        self.id = str(model.get("id", ""))
        self.provider = str(model.get("provider", ""))
        name = model.get("name")
        self.name = str(name) if name else None


@dataclass
class _ProviderOption:
    id: str
    name: str
    model_count: int


class ModelSelectorComponent(Container):
    """Two-step model selector: choose provider, then choose a model."""

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
        self._step: SelectorStep = "provider"
        self._selected_provider: str | None = None
        self._all_models: list[Model[Any]] = []
        self._scoped_model_items: list[Model[Any]] = []
        self._provider_models: list[Model[Any]] = []
        self._providers: list[_ProviderOption] = []
        self._filtered_providers: list[_ProviderOption] = []
        self._filtered_models: list[Model[Any]] = []
        self._selected_index = 0
        self._error_message: str | None = None
        self._scope_text: Text | None = None
        self._title_text: Text | None = None
        self._hint_text: Text | None = None
        self._loading = True
        self._initial_search = initial_search

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self._title_text = Text(theme.fg("accent", "Select provider"), padding_x=1, padding_y=0)
        self.add_child(self._title_text)
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

        self._hint_text = Text(
            theme.fg("muted", "Enter: open models  Esc: cancel"),
            padding_x=1,
            padding_y=0,
        )
        self.add_child(self._hint_text)
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
            self._apply_initial_navigation()
            self._update_list()

    async def _load_models_async(self) -> None:
        try:
            await asyncio.to_thread(self._model_registry.refresh)
            self._load_models()
        except Exception as error:
            self._all_models = []
            self._scoped_model_items = []
            self._provider_models = []
            self._providers = []
            self._filtered_providers = []
            self._filtered_models = []
            self._error_message = str(error)
        finally:
            self._loading = False
            self._apply_initial_navigation()
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
        if self._scope_text is not None:
            self._scope_text.set_text(self._get_scope_text())
        self._rebuild_providers()
        if self._step == "models" and self._selected_provider:
            if not any(p.id == self._selected_provider for p in self._providers):
                self._show_provider_step(clear_search=False)
            else:
                self._show_models_step(self._selected_provider, clear_search=False)
        else:
            self._filter_current(self._search_input.get_value())

    def _load_models(self) -> None:
        self._error_message = self._model_registry.get_error()
        try:
            self._all_models = self._sort_models(self._model_registry.get_available())
        except Exception as error:
            self._all_models = []
            self._scoped_model_items = []
            self._provider_models = []
            self._providers = []
            self._filtered_providers = []
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

        self._rebuild_providers()

    def _source_models(self) -> list[Model[Any]]:
        if self._scope == "scoped":
            return list(self._scoped_model_items)
        return list(self._all_models)

    def _rebuild_providers(self) -> None:
        counts: dict[str, int] = {}
        for model in self._source_models():
            provider = str(model.get("provider", "")).strip()
            if not provider:
                continue
            counts[provider] = counts.get(provider, 0) + 1

        current_provider = (
            str(self._current_model.get("provider", "")) if self._current_model else ""
        )
        providers = [
            _ProviderOption(
                id=provider_id,
                name=self._model_registry.get_provider_display_name(provider_id),
                model_count=count,
            )
            for provider_id, count in counts.items()
        ]
        providers.sort(
            key=lambda item: (
                0 if item.id == current_provider else 1,
                item.name.lower(),
                item.id.lower(),
            )
        )
        self._providers = providers
        self._filtered_providers = list(providers)

    def _sort_models(self, models: list[Model[Any]]) -> list[Model[Any]]:
        return sorted(
            models,
            key=lambda model: (
                0 if models_are_equal(self._current_model, model) else 1,
                str(model.get("provider", "")),
                str(model.get("id", "")),
            ),
        )

    def _apply_initial_navigation(self) -> None:
        if self._error_message:
            return

        search = (self._initial_search or "").strip()
        if search:
            needle = search.lower()
            exact = next((p for p in self._providers if p.id.lower() == needle), None)
            if exact is not None:
                self._show_models_step(exact.id, clear_search=True)
                return
            prefix_matches = [p for p in self._providers if p.id.lower().startswith(needle)]
            if len(prefix_matches) == 1:
                self._show_models_step(prefix_matches[0].id, clear_search=True)
                return
            self._filter_current(search)
            return

        if len(self._providers) == 1:
            self._show_models_step(self._providers[0].id, clear_search=True)
            return

        current_provider = (
            str(self._current_model.get("provider", "")) if self._current_model else ""
        )
        if current_provider and any(p.id == current_provider for p in self._providers):
            self._selected_index = next(
                (i for i, p in enumerate(self._providers) if p.id == current_provider),
                0,
            )
        self._filter_current("")

    def _show_provider_step(self, *, clear_search: bool) -> None:
        self._step = "provider"
        self._selected_provider = None
        self._provider_models = []
        self._filtered_models = []
        if clear_search:
            self._search_input.set_value("")
        if self._title_text is not None:
            self._title_text.set_text(theme.fg("accent", "Select provider"))
        if self._hint_text is not None:
            self._hint_text.set_text(
                theme.fg("muted", "Enter: open models  Esc: cancel")
            )
        current_provider = (
            str(self._current_model.get("provider", "")) if self._current_model else ""
        )
        self._selected_index = next(
            (i for i, p in enumerate(self._providers) if p.id == current_provider),
            0,
        )
        self._filter_current(self._search_input.get_value())

    def _show_models_step(self, provider_id: str, *, clear_search: bool) -> None:
        self._step = "models"
        self._selected_provider = provider_id
        self._provider_models = [
            model
            for model in self._source_models()
            if str(model.get("provider", "")) == provider_id
        ]
        display_name = self._model_registry.get_provider_display_name(provider_id)
        if self._title_text is not None:
            self._title_text.set_text(
                theme.fg("accent", f"Select model — {display_name}")
            )
        if self._hint_text is not None:
            self._hint_text.set_text(
                theme.fg("muted", "Enter: select  Esc: back to providers")
            )
        if clear_search:
            self._search_input.set_value("")
        current_index = next(
            (
                index
                for index, model in enumerate(self._provider_models)
                if models_are_equal(self._current_model, model)
            ),
            0,
        )
        self._selected_index = current_index
        self._filter_current(self._search_input.get_value())

    def _filter_current(self, query: str) -> None:
        if self._step == "provider":
            if query.strip():
                self._filtered_providers = fuzzy_filter(
                    self._providers,
                    query,
                    lambda provider: f"{provider.id} {provider.name}",
                )
            else:
                self._filtered_providers = list(self._providers)
            self._selected_index = min(
                self._selected_index, max(0, len(self._filtered_providers) - 1)
            )
        else:
            if query.strip():
                self._filtered_models = fuzzy_filter(
                    self._provider_models,
                    query,
                    lambda model: get_model_selector_search_text(_ModelSearchAdapter(model)),
                )
            else:
                self._filtered_models = list(self._provider_models)
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

        if self._step == "provider":
            self._render_provider_list()
        else:
            self._render_model_list()
        self._ui.request_render()

    def _render_provider_list(self) -> None:
        if not self._filtered_providers:
            if not self._providers:
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
                    Text(theme.fg("muted", "  No matching providers"), padding_x=1, padding_y=0)
                )
            return

        start_index = max(
            0,
            min(
                self._selected_index - _MAX_VISIBLE // 2,
                len(self._filtered_providers) - _MAX_VISIBLE,
            ),
        )
        end_index = min(start_index + _MAX_VISIBLE, len(self._filtered_providers))
        current_provider = (
            str(self._current_model.get("provider", "")) if self._current_model else ""
        )

        for index in range(start_index, end_index):
            provider = self._filtered_providers[index]
            is_selected = index == self._selected_index
            is_current = provider.id == current_provider
            count_label = theme.fg("muted", f"({provider.model_count})")
            checkmark = theme.fg("success", " ✓") if is_current else ""
            if is_selected:
                line = (
                    f"{theme.fg('accent', '→ ')}"
                    f"{theme.fg('accent', provider.name)} "
                    f"{theme.fg('muted', provider.id)} {count_label}{checkmark}"
                )
            else:
                line = f"  {provider.name} {theme.fg('muted', provider.id)} {count_label}{checkmark}"
            self._list_container.add_child(Text(line, padding_x=1, padding_y=0))

        if start_index > 0 or end_index < len(self._filtered_providers):
            scroll_info = theme.fg(
                "muted", f"  ({self._selected_index + 1}/{len(self._filtered_providers)})"
            )
            self._list_container.add_child(Text(scroll_info, padding_x=1, padding_y=0))

    def _render_model_list(self) -> None:
        if not self._filtered_models:
            self._list_container.add_child(
                Text(theme.fg("muted", "  No matching models"), padding_x=1, padding_y=0)
            )
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
            checkmark = theme.fg("success", " ✓") if is_current else ""
            if is_selected:
                line = f"{theme.fg('accent', '→ ')}{theme.fg('accent', model_id)}{checkmark}"
            else:
                line = f"  {model_id}{checkmark}"
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

    def _select_current(self) -> None:
        if self._step == "provider":
            if not self._filtered_providers:
                return
            provider = self._filtered_providers[self._selected_index]
            self._show_models_step(provider.id, clear_search=True)
            return
        if not self._filtered_models:
            return
        self._handle_select(self._filtered_models[self._selected_index])

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
            items = self._filtered_providers if self._step == "provider" else self._filtered_models
            if not items:
                return
            self._selected_index = len(items) - 1 if self._selected_index == 0 else self._selected_index - 1
            self._update_list()
            return
        if kb.matches(data, "tui.select.down"):
            items = self._filtered_providers if self._step == "provider" else self._filtered_models
            if not items:
                return
            self._selected_index = (
                0 if self._selected_index == len(items) - 1 else self._selected_index + 1
            )
            self._update_list()
            return
        if kb.matches(data, "tui.select.confirm"):
            self._select_current()
            return
        if kb.matches(data, "tui.select.cancel"):
            if self._step == "models" and len(self._providers) > 1:
                self._show_provider_step(clear_search=True)
                return
            self._on_cancel()
            return
        self._search_input.handle_input(data)
        self._filter_current(self._search_input.get_value())
