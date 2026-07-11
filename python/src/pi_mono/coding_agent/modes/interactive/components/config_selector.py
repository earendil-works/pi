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
ConfigWriteScope = Literal["global", "project"]
ScopedResolvedPaths = dict[ConfigWriteScope, ResolvedPaths]


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
        resolved_paths: ScopedResolvedPaths | list[ConfigResourceItem],
        settings_manager: SettingsManager,
        on_close: Callable[[], None],
        *,
        write_scope: ConfigWriteScope = "global",
        project_mode_available: bool = False,
    ) -> None:
        super().__init__()
        if isinstance(resolved_paths, list):
            self._scoped_paths: ScopedResolvedPaths = {
                "global": {
                    "extensions": [],
                    "skills": [],
                    "prompts": [],
                    "themes": [],
                },
                "project": {
                    "extensions": [],
                    "skills": [],
                    "prompts": [],
                    "themes": [],
                },
            }
            self._legacy_items = resolved_paths
        else:
            self._scoped_paths = resolved_paths
            self._legacy_items = None
        self._settings_manager = settings_manager
        self._on_close = on_close
        self._write_scope: ConfigWriteScope = write_scope
        self._project_mode_available = project_mode_available
        self._selected_index = 0
        self._title_text = Text("", 1, 0)
        self._hint_text = Text("", 1, 0)
        self._list_container = Container()
        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(self._title_text)
        self.add_child(self._hint_text)
        self.add_child(Spacer(1))
        self.add_child(self._list_container)
        self.add_child(Spacer(1))
        self.add_child(
            Text(
                raw_key_hint("↑↓", "navigate")
                + "  "
                + key_hint("tui.select.confirm", "toggle")
                + (
                    ("  " + key_hint("tui.input.tab", "switch mode"))
                    if self._project_mode_available
                    else ""
                )
                + "  "
                + key_hint("tui.select.cancel", "close"),
                1,
                0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())
        self._refresh_header()
        self._update_list()

    def _active_items(self) -> list[ConfigResourceItem]:
        if self._legacy_items is not None:
            return self._legacy_items
        return flatten_resolved_paths(self._scoped_paths[self._write_scope])

    def _refresh_header(self) -> None:
        title = (
            "Project Local Resources"
            if self._write_scope == "project"
            else "Global Resources"
        )
        self._title_text.set_text(theme.fg("accent", theme.bold(title)))
        if self._write_scope == "project":
            hint = "Space cycles inherit/+/- · Esc closes"
        else:
            hint = "Space toggles resource · Esc closes"
        if self._project_mode_available:
            hint += " · Tab switches mode"
        self._hint_text.set_text(theme.fg("muted", hint))

    def _update_list(self) -> None:
        items = self._active_items()
        self._list_container.clear()
        if not items:
            self._list_container.add_child(
                Text(theme.fg("muted", "No configurable resources found."), 1, 0)
            )
            return
        self._selected_index = min(self._selected_index, len(items) - 1)
        for index, item in enumerate(items):
            checkbox = theme.fg("success", "[x]") if item.enabled else theme.fg("dim", "[ ]")
            prefix = theme.fg("accent", "→ ") if index == self._selected_index else "  "
            color = (
                "dim"
                if self._write_scope == "project" and item.scope == "user"
                else ("accent" if index == self._selected_index else "text")
            )
            label = theme.fg(color, item.label)
            self._list_container.add_child(Text(f"{prefix}{checkbox} {label}", 1, 0))

    def _toggle_item(self, item: ConfigResourceItem, enabled: bool) -> None:
        item.enabled = enabled
        pattern = item.path
        disable_pattern = f"-{pattern}"
        enable_pattern = f"+{pattern}"
        use_project = self._write_scope == "project" or item.scope == "project"
        if use_project:
            settings = self._settings_manager.get_project_settings()
            setter = {
                "extensions": self._settings_manager.set_project_extension_paths,
                "skills": self._settings_manager.set_project_skill_paths,
                "prompts": self._settings_manager.set_project_prompt_template_paths,
                "themes": self._settings_manager.set_project_theme_paths,
            }[item.resource_type]
            current = list(settings.get(item.resource_type) or [])
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

    def _switch_write_scope(self) -> None:
        if not self._project_mode_available:
            return
        self._write_scope = "project" if self._write_scope == "global" else "global"
        self._selected_index = 0
        self._refresh_header()
        self._update_list()

    def handle_input(self, key_data: str) -> None:
        items = self._active_items()
        kb = get_keybindings()
        if kb.matches(key_data, "tui.input.tab"):
            self._switch_write_scope()
            return
        if not items:
            if kb.matches(key_data, "tui.select.cancel"):
                self._on_close()
            return
        if kb.matches(key_data, "tui.select.up") or key_data == "k":
            self._selected_index = max(0, self._selected_index - 1)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.down") or key_data == "j":
            self._selected_index = min(len(items) - 1, self._selected_index + 1)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.confirm") or key_data == "\n" or key_data == " ":
            item = items[self._selected_index]
            self._toggle_item(item, not item.enabled)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.cancel"):
            self._on_close()
