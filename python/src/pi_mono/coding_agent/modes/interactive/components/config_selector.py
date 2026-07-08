"""TUI config selector for `pi config`."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from pi_mono.coding_agent.core.package_manager import ResolvedPaths
from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import (
    key_hint,
    raw_key_hint,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container

ResourceScope = Literal["extensions", "skills", "prompts", "themes"]


@dataclass
class ConfigResourceItem:
    path: str
    enabled: bool
    resource_type: ResourceScope
    scope: Literal["user", "project"]
    label: str


def flatten_resolved_paths(resolved: ResolvedPaths) -> list[ConfigResourceItem]:
    items: list[ConfigResourceItem] = []
    for resource_type in ("extensions", "skills", "prompts", "themes"):
        for entry in resolved.get(resource_type, []):
            metadata = entry.get("metadata", {})
            scope = metadata.get("scope", "user")
            label = os.path.basename(entry["path"]) or entry["path"]
            items.append(
                ConfigResourceItem(
                    path=entry["path"],
                    enabled=bool(entry.get("enabled", True)),
                    resource_type=resource_type,  # type: ignore[arg-type]
                    scope=scope,  # type: ignore[arg-type]
                    label=f"{resource_type[:-1]}: {label}",
                )
            )
    return items


class ConfigSelectorComponent(Container):
    def __init__(
        self,
        items: list[ConfigResourceItem],
        settings_manager: SettingsManager,
        on_close: Callable[[], None],
    ) -> None:
        super().__init__()
        self._items = items
        self._settings_manager = settings_manager
        self._on_close = on_close
        self._selected_index = 0
        self._list_container = Container()
        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", theme.bold("pi config")), 1, 0))
        self.add_child(Text(theme.fg("muted", "Space toggles resource · Esc closes"), 1, 0))
        self.add_child(Spacer(1))
        self.add_child(self._list_container)
        self.add_child(Spacer(1))
        self.add_child(
            Text(
                raw_key_hint("↑↓", "navigate")
                + "  "
                + key_hint("tui.select.confirm", "toggle")
                + "  "
                + key_hint("tui.select.cancel", "close"),
                1,
                0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())
        self._update_list()

    def _update_list(self) -> None:
        self._list_container.clear()
        if not self._items:
            self._list_container.add_child(
                Text(theme.fg("muted", "No configurable resources found."), 1, 0)
            )
            return
        for index, item in enumerate(self._items):
            checkbox = theme.fg("success", "[x]") if item.enabled else theme.fg("dim", "[ ]")
            prefix = theme.fg("accent", "→ ") if index == self._selected_index else "  "
            label = (
                theme.fg("accent", item.label)
                if index == self._selected_index
                else theme.fg("text", item.label)
            )
            self._list_container.add_child(Text(f"{prefix}{checkbox} {label}", 1, 0))

    def _toggle_item(self, item: ConfigResourceItem, enabled: bool) -> None:
        item.enabled = enabled
        pattern = item.path
        disable_pattern = f"-{pattern}"
        enable_pattern = f"+{pattern}"
        if item.scope == "project":
            settings = self._settings_manager.get_project_settings()
            key = item.resource_type
            setter = {
                "extensions": self._settings_manager.set_project_extension_paths,
                "skills": self._settings_manager.set_project_skill_paths,
                "prompts": self._settings_manager.set_project_prompt_template_paths,
                "themes": self._settings_manager.set_project_theme_paths,
            }[item.resource_type]
            current = list(settings.get(key) or [])
        else:
            getter = {
                "extensions": self._settings_manager.get_extension_paths,
                "skills": self._settings_manager.get_skill_paths,
                "prompts": self._settings_manager.get_prompt_template_paths,
                "themes": self._settings_manager.get_theme_paths,
            }[item.resource_type]
            setter = {
                "extensions": self._settings_manager.set_extension_paths,
                "skills": self._settings_manager.set_skill_paths,
                "prompts": self._settings_manager.set_prompt_template_paths,
                "themes": self._settings_manager.set_theme_paths,
            }[item.resource_type]
            current = list(getter())
        updated = [entry for entry in current if entry.lstrip("!+-") != pattern]
        updated.append(enable_pattern if enabled else disable_pattern)
        setter(updated)
        self._settings_manager.save()

    def handle_input(self, key_data: str) -> None:
        if not self._items:
            if get_keybindings().matches(key_data, "tui.select.cancel"):
                self._on_close()
            return
        kb = get_keybindings()
        if kb.matches(key_data, "tui.select.up") or key_data == "k":
            self._selected_index = max(0, self._selected_index - 1)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.down") or key_data == "j":
            self._selected_index = min(len(self._items) - 1, self._selected_index + 1)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.confirm") or key_data == "\n" or key_data == " ":
            item = self._items[self._selected_index]
            self._toggle_item(item, not item.enabled)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.cancel"):
            self._on_close()
