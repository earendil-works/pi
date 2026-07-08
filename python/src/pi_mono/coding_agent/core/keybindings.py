"""Application keybindings merged with TUI defaults."""

from __future__ import annotations

import json
import os
import sys

from pi_mono.config import get_agent_dir
from pi_mono.tui.keybindings import KeybindingDefinition, KeybindingsManager, TUI_KEYBINDINGS

APP_KEYBINDINGS: dict[str, KeybindingDefinition] = {
    "app.interrupt": KeybindingDefinition("escape", "Cancel or abort"),
    "app.clear": KeybindingDefinition("ctrl+c", "Clear editor"),
    "app.exit": KeybindingDefinition("ctrl+d", "Exit when editor is empty"),
    "app.suspend": KeybindingDefinition(
        [] if sys.platform == "win32" else "ctrl+z",
        "Suspend to background",
    ),
    "app.thinking.cycle": KeybindingDefinition("shift+tab", "Cycle thinking level"),
    "app.model.cycleForward": KeybindingDefinition("ctrl+p", "Cycle to next model"),
    "app.model.cycleBackward": KeybindingDefinition("shift+ctrl+p", "Cycle to previous model"),
    "app.model.select": KeybindingDefinition("ctrl+l", "Open model selector"),
    "app.tools.expand": KeybindingDefinition("ctrl+o", "Toggle tool output"),
    "app.thinking.toggle": KeybindingDefinition("ctrl+t", "Toggle thinking blocks"),
    "app.session.toggleNamedFilter": KeybindingDefinition("ctrl+n", "Toggle named session filter"),
    "app.editor.external": KeybindingDefinition("ctrl+g", "Open external editor"),
    "app.message.followUp": KeybindingDefinition("alt+enter", "Queue follow-up message"),
    "app.message.dequeue": KeybindingDefinition("alt+up", "Restore queued messages"),
    "app.clipboard.pasteImage": KeybindingDefinition(
        "alt+v" if sys.platform == "win32" else "ctrl+v",
        "Paste image from clipboard",
    ),
    "app.session.new": KeybindingDefinition([], "Start a new session"),
    "app.session.tree": KeybindingDefinition([], "Open session tree"),
    "app.session.fork": KeybindingDefinition([], "Fork current session"),
    "app.session.resume": KeybindingDefinition([], "Resume a session"),
    "app.tree.foldOrUp": KeybindingDefinition(
        ["ctrl+left", "alt+left"],
        "Fold tree branch or move up",
    ),
    "app.tree.unfoldOrDown": KeybindingDefinition(
        ["ctrl+right", "alt+right"],
        "Unfold tree branch or move down",
    ),
    "app.tree.editLabel": KeybindingDefinition("shift+l", "Edit tree label"),
    "app.tree.toggleLabelTimestamp": KeybindingDefinition(
        "shift+t", "Toggle tree label timestamps"
    ),
    "app.session.togglePath": KeybindingDefinition("ctrl+p", "Toggle session path display"),
    "app.session.toggleSort": KeybindingDefinition("ctrl+s", "Toggle session sort mode"),
    "app.session.rename": KeybindingDefinition("ctrl+r", "Rename session"),
    "app.session.delete": KeybindingDefinition("ctrl+d", "Delete session"),
    "app.session.deleteNoninvasive": KeybindingDefinition(
        "ctrl+backspace", "Delete session when query is empty"
    ),
    "app.models.save": KeybindingDefinition("ctrl+s", "Save model selection"),
    "app.models.enableAll": KeybindingDefinition("ctrl+a", "Enable all models"),
    "app.models.clearAll": KeybindingDefinition("ctrl+x", "Clear all models"),
    "app.models.toggleProvider": KeybindingDefinition("ctrl+p", "Toggle all models for provider"),
    "app.models.reorderUp": KeybindingDefinition("alt+up", "Move model up in order"),
    "app.models.reorderDown": KeybindingDefinition("alt+down", "Move model down in order"),
    "app.tree.filter.default": KeybindingDefinition("ctrl+d", "Tree filter: default view"),
    "app.tree.filter.noTools": KeybindingDefinition("ctrl+t", "Tree filter: hide tool results"),
    "app.tree.filter.userOnly": KeybindingDefinition("ctrl+u", "Tree filter: user messages only"),
    "app.tree.filter.labeledOnly": KeybindingDefinition(
        "ctrl+l", "Tree filter: labeled entries only"
    ),
    "app.tree.filter.all": KeybindingDefinition("ctrl+a", "Tree filter: show all entries"),
    "app.tree.filter.cycleForward": KeybindingDefinition("ctrl+o", "Tree filter: cycle forward"),
    "app.tree.filter.cycleBackward": KeybindingDefinition(
        "shift+ctrl+o", "Tree filter: cycle backward"
    ),
}

DEFAULT_APP_KEYBINDINGS: dict[str, KeybindingDefinition] = {**TUI_KEYBINDINGS, **APP_KEYBINDINGS}

KEYBINDING_NAME_MIGRATIONS: dict[str, str] = {
    "cursorUp": "tui.editor.cursorUp",
    "cursorDown": "tui.editor.cursorDown",
    "cursorLeft": "tui.editor.cursorLeft",
    "cursorRight": "tui.editor.cursorRight",
    "cursorWordLeft": "tui.editor.cursorWordLeft",
    "cursorWordRight": "tui.editor.cursorWordRight",
    "cursorLineStart": "tui.editor.cursorLineStart",
    "cursorLineEnd": "tui.editor.cursorLineEnd",
    "jumpForward": "tui.editor.jumpForward",
    "jumpBackward": "tui.editor.jumpBackward",
    "pageUp": "tui.editor.pageUp",
    "pageDown": "tui.editor.pageDown",
    "deleteCharBackward": "tui.editor.deleteCharBackward",
    "deleteCharForward": "tui.editor.deleteCharForward",
    "deleteWordBackward": "tui.editor.deleteWordBackward",
    "deleteWordForward": "tui.editor.deleteWordForward",
    "deleteToLineStart": "tui.editor.deleteToLineStart",
    "deleteToLineEnd": "tui.editor.deleteToLineEnd",
    "yank": "tui.editor.yank",
    "yankPop": "tui.editor.yankPop",
    "undo": "tui.editor.undo",
    "newLine": "tui.input.newLine",
    "submit": "tui.input.submit",
    "tab": "tui.input.tab",
    "copy": "tui.input.copy",
    "selectUp": "tui.select.up",
    "selectDown": "tui.select.down",
    "selectPageUp": "tui.select.pageUp",
    "selectPageDown": "tui.select.pageDown",
    "selectConfirm": "tui.select.confirm",
    "selectCancel": "tui.select.cancel",
    "interrupt": "app.interrupt",
    "clear": "app.clear",
    "exit": "app.exit",
    "suspend": "app.suspend",
    "cycleThinkingLevel": "app.thinking.cycle",
    "cycleModelForward": "app.model.cycleForward",
    "cycleModelBackward": "app.model.cycleBackward",
    "selectModel": "app.model.select",
    "expandTools": "app.tools.expand",
    "toggleThinking": "app.thinking.toggle",
    "toggleSessionNamedFilter": "app.session.toggleNamedFilter",
    "externalEditor": "app.editor.external",
    "followUp": "app.message.followUp",
    "dequeue": "app.message.dequeue",
    "pasteImage": "app.clipboard.pasteImage",
    "newSession": "app.session.new",
    "tree": "app.session.tree",
    "fork": "app.session.fork",
    "resume": "app.session.resume",
    "treeFoldOrUp": "app.tree.foldOrUp",
    "treeUnfoldOrDown": "app.tree.unfoldOrDown",
    "treeEditLabel": "app.tree.editLabel",
    "treeToggleLabelTimestamp": "app.tree.toggleLabelTimestamp",
    "toggleSessionPath": "app.session.togglePath",
    "toggleSessionSort": "app.session.toggleSort",
    "renameSession": "app.session.rename",
    "deleteSession": "app.session.delete",
    "deleteSessionNoninvasive": "app.session.deleteNoninvasive",
}


def _is_record(value: object) -> bool:
    return isinstance(value, dict)


def _to_keybindings_config(value: object) -> dict[str, str | list[str]]:
    if not _is_record(value):
        return {}
    config: dict[str, str | list[str]] = {}
    for key, binding in value.items():
        if isinstance(binding, str):
            config[key] = binding
        elif isinstance(binding, list) and all(isinstance(entry, str) for entry in binding):
            config[key] = binding
    return config


def migrate_keybindings_config(raw_config: dict[str, object]) -> tuple[dict[str, object], bool]:
    config: dict[str, object] = {}
    migrated = False
    for key, value in raw_config.items():
        next_key = KEYBINDING_NAME_MIGRATIONS.get(key, key)
        if next_key != key:
            migrated = True
        if key != next_key and next_key in raw_config:
            migrated = True
            continue
        config[next_key] = value
    return _order_keybindings_config(config), migrated


def _order_keybindings_config(config: dict[str, object]) -> dict[str, object]:
    ordered: dict[str, object] = {}
    for keybinding in DEFAULT_APP_KEYBINDINGS:
        if keybinding in config:
            ordered[keybinding] = config[keybinding]
    for key in sorted(config):
        if key not in ordered:
            ordered[key] = config[key]
    return ordered


def _load_raw_config(path: str) -> dict[str, object] | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            parsed = json.load(handle)
        return parsed if _is_record(parsed) else None
    except (OSError, json.JSONDecodeError):
        return None


class CodingAgentKeybindingsManager(KeybindingsManager):
    def __init__(
        self,
        user_bindings: dict[str, str | list[str]] | None = None,
        config_path: str | None = None,
    ) -> None:
        super().__init__(DEFAULT_APP_KEYBINDINGS, user_bindings)
        self.config_path = config_path

    @classmethod
    def create(cls, agent_dir: str | None = None) -> CodingAgentKeybindingsManager:
        resolved_agent_dir = agent_dir or str(get_agent_dir())
        config_path = os.path.join(resolved_agent_dir, "keybindings.json")
        user_bindings = cls._load_from_file(config_path)
        return cls(user_bindings, config_path)

    def reload(self) -> None:
        if not self.config_path:
            return
        self.user_bindings = self._load_from_file(self.config_path)
        self.rebuild()

    def get_effective_config(self) -> dict[str, str | list[str]]:
        return self.get_resolved_bindings()

    @staticmethod
    def _load_from_file(path: str) -> dict[str, str | list[str]]:
        raw_config = _load_raw_config(path)
        if not raw_config:
            return {}
        migrated = migrate_keybindings_config(raw_config)
        return _to_keybindings_config(migrated[0])
