"""OAuth provider selector for /login and /logout."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.tui.components.input import Input
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.truncated_text import TruncatedText
from pi_mono.tui.fuzzy import fuzzy_filter
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container


@dataclass
class AuthSelectorProvider:
    id: str
    name: str
    auth_type: Literal["oauth", "api_key"]


class OAuthSelectorComponent(Container):
    """Provider list with search and auth status indicators."""

    def __init__(
        self,
        mode: Literal["login", "logout"],
        auth_storage: AuthStorage,
        providers: list[AuthSelectorProvider],
        on_select: Callable[[str], None],
        on_cancel: Callable[[], None],
        get_auth_status: Callable[[str], dict[str, Any]] | None = None,
    ) -> None:
        super().__init__()
        self._mode = mode
        self._auth_storage = auth_storage
        self._all_providers = providers
        self._filtered_providers = list(providers)
        self._selected_index = 0
        self._on_select = on_select
        self._on_cancel = on_cancel
        self._get_auth_status = get_auth_status or auth_storage.get_auth_status

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))

        title = "Select provider to configure:" if mode == "login" else "Select provider to logout:"
        self.add_child(
            TruncatedText(theme.fg("accent", theme.bold(title)), padding_x=1, padding_y=0)
        )
        self.add_child(Spacer(1))

        self._search_input = Input()
        self._search_input.on_submit = self._select_current
        self.add_child(self._search_input)
        self.add_child(Spacer(1))

        self._list_container = Container()
        self.add_child(self._list_container)
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())
        self._filter_providers("")

    @property
    def focused(self) -> bool:
        return self._search_input.focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._search_input.focused = value

    def _format_status_indicator(self, provider: AuthSelectorProvider) -> str:
        if provider.id == "cursor":
            status = self._get_auth_status(provider.id)
            source = status.get("source")
            if status.get("configured") and source == "cursor_cli":
                return theme.fg("success", " ✓ agent logged in")
            if status.get("configured") and source == "stored":
                return theme.fg("success", " ✓ configured")

        credential = self._auth_storage.get(provider.id)
        if credential and credential.get("type") == provider.auth_type:
            return theme.fg("success", " ✓ configured")
        if credential:
            label = (
                "subscription configured"
                if credential.get("type") == "oauth"
                else "API key configured"
            )
            return theme.fg("muted", " • ") + theme.fg("warning", label)
        if provider.auth_type != "api_key":
            return theme.fg("muted", " • unconfigured")

        status = self._get_auth_status(provider.id)
        source = status.get("source")
        if source == "environment":
            label = status.get("label") or "API key"
            return theme.fg("success", f" ✓ env: {label}")
        if source == "runtime":
            return theme.fg("success", " ✓ runtime API key")
        if source == "fallback":
            return theme.fg("success", " ✓ custom API key")
        if source == "models_json_key":
            return theme.fg("success", " ✓ key in models.json")
        if source == "models_json_command":
            return theme.fg("success", " ✓ command in models.json")
        return theme.fg("muted", " • unconfigured")

    def _filter_providers(self, query: str) -> None:
        if query.strip():
            self._filtered_providers = fuzzy_filter(
                self._all_providers,
                query,
                lambda provider: f"{provider.name} {provider.id} {provider.auth_type}",
            )
        else:
            self._filtered_providers = list(self._all_providers)
        self._selected_index = min(
            self._selected_index,
            max(0, len(self._filtered_providers) - 1),
        )
        self._update_list()

    def _update_list(self) -> None:
        self._list_container.clear()
        max_visible = 8
        start_index = max(
            0,
            min(
                self._selected_index - max_visible // 2,
                len(self._filtered_providers) - max_visible,
            ),
        )
        end_index = min(start_index + max_visible, len(self._filtered_providers))

        for index in range(start_index, end_index):
            provider = self._filtered_providers[index]
            is_selected = index == self._selected_index
            status = self._format_status_indicator(provider)
            if is_selected:
                line = theme.fg("accent", "→ ") + theme.fg("accent", provider.name) + status
            else:
                line = f"  {theme.fg('text', provider.name)}{status}"
            self._list_container.add_child(TruncatedText(line, padding_x=1, padding_y=0))

        if start_index > 0 or end_index < len(self._filtered_providers):
            scroll = theme.fg(
                "muted",
                f"  ({self._selected_index + 1}/{len(self._filtered_providers)})",
            )
            self._list_container.add_child(TruncatedText(scroll, padding_x=1, padding_y=0))

        if not self._filtered_providers:
            if not self._all_providers:
                message = (
                    "No providers available"
                    if self._mode == "login"
                    else "No providers logged in. Use /login first."
                )
            else:
                message = "No matching providers"
            self._list_container.add_child(
                TruncatedText(theme.fg("muted", f"  {message}"), padding_x=1, padding_y=0)
            )

    def _select_current(self) -> None:
        if 0 <= self._selected_index < len(self._filtered_providers):
            self._on_select(self._filtered_providers[self._selected_index].id)

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()
        if kb.matches(data, "tui.select.up"):
            if self._filtered_providers:
                self._selected_index = max(0, self._selected_index - 1)
                self._update_list()
            return
        if kb.matches(data, "tui.select.down"):
            if self._filtered_providers:
                self._selected_index = min(
                    len(self._filtered_providers) - 1, self._selected_index + 1
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
        self._filter_providers(self._search_input.get_value())
