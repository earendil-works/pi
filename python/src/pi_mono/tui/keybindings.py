from typing import Dict, List, Optional, Set, Union
from pi_mono.tui.keys import matches_key


class KeybindingDefinition:
    """
    Represents the default configuration and description for a keybinding.
    """

    def __init__(self, default_keys: Union[str, List[str]], description: Optional[str] = None):
        self.default_keys = default_keys
        self.description = description


# Default keybindings dictionary
TUI_KEYBINDINGS: Dict[str, KeybindingDefinition] = {
    "tui.editor.cursorUp": KeybindingDefinition("up", "Move cursor up"),
    "tui.editor.cursorDown": KeybindingDefinition("down", "Move cursor down"),
    "tui.editor.cursorLeft": KeybindingDefinition(["left", "ctrl+b"], "Move cursor left"),
    "tui.editor.cursorRight": KeybindingDefinition(["right", "ctrl+f"], "Move cursor right"),
    "tui.editor.cursorWordLeft": KeybindingDefinition(
        ["alt+left", "ctrl+left", "alt+b"], "Move cursor word left"
    ),
    "tui.editor.cursorWordRight": KeybindingDefinition(
        ["alt+right", "ctrl+right", "alt+f"], "Move cursor word right"
    ),
    "tui.editor.cursorLineStart": KeybindingDefinition(["home", "ctrl+a"], "Move to line start"),
    "tui.editor.cursorLineEnd": KeybindingDefinition(["end", "ctrl+e"], "Move to line end"),
    "tui.editor.jumpForward": KeybindingDefinition("ctrl+]", "Jump forward to character"),
    "tui.editor.jumpBackward": KeybindingDefinition("ctrl+alt+]", "Jump backward to character"),
    "tui.editor.pageUp": KeybindingDefinition("pageUp", "Page up"),
    "tui.editor.pageDown": KeybindingDefinition("pageDown", "Page down"),
    "tui.editor.deleteCharBackward": KeybindingDefinition("backspace", "Delete character backward"),
    "tui.editor.deleteCharForward": KeybindingDefinition(
        ["delete", "ctrl+d"], "Delete character forward"
    ),
    "tui.editor.deleteWordBackward": KeybindingDefinition(
        ["ctrl+w", "alt+backspace"], "Delete word backward"
    ),
    "tui.editor.deleteWordForward": KeybindingDefinition(
        ["alt+d", "alt+delete"], "Delete word forward"
    ),
    "tui.editor.deleteToLineStart": KeybindingDefinition("ctrl+u", "Delete to line start"),
    "tui.editor.deleteToLineEnd": KeybindingDefinition("ctrl+k", "Delete to line end"),
    "tui.editor.yank": KeybindingDefinition("ctrl+y", "Yank"),
    "tui.editor.yankPop": KeybindingDefinition("alt+y", "Yank pop"),
    "tui.editor.undo": KeybindingDefinition("ctrl+-", "Undo"),
    "tui.input.newLine": KeybindingDefinition("shift+enter", "Insert newline"),
    "tui.input.submit": KeybindingDefinition("enter", "Submit input"),
    "tui.input.tab": KeybindingDefinition("tab", "Tab / autocomplete"),
    "tui.input.copy": KeybindingDefinition("ctrl+c", "Copy selection"),
    "tui.select.up": KeybindingDefinition("up", "Move selection up"),
    "tui.select.down": KeybindingDefinition("down", "Move selection down"),
    "tui.select.pageUp": KeybindingDefinition("pageUp", "Selection page up"),
    "tui.select.pageDown": KeybindingDefinition("pageDown", "Selection page down"),
    "tui.select.confirm": KeybindingDefinition("enter", "Confirm selection"),
    "tui.select.cancel": KeybindingDefinition(["escape", "ctrl+c"], "Cancel selection"),
}


class KeybindingConflict:
    """
    Represents a conflict where the same key is bound to multiple keybindings.
    """

    def __init__(self, key: str, keybindings: List[str]):
        self.key = key
        self.keybindings = keybindings


def normalize_keys(keys: Optional[Union[str, List[str]]]) -> List[str]:
    if keys is None:
        return []
    key_list = keys if isinstance(keys, list) else [keys]
    seen: Set[str] = set()
    result: List[str] = []
    for key in key_list:
        if key not in seen:
            seen.add(key)
            result.append(key)
    return result


class KeybindingsManager:
    """
    Manages keybindings, resolving user configurations and detecting conflicts.
    """

    def __init__(
        self,
        definitions: Dict[str, KeybindingDefinition],
        user_bindings: Optional[Dict[str, Union[str, List[str]]]] = None,
    ):
        self.definitions = definitions
        self.user_bindings = user_bindings or {}
        self.keys_by_id: Dict[str, List[str]] = {}
        self.conflicts: List[KeybindingConflict] = []
        self.rebuild()

    def rebuild(self) -> None:
        self.keys_by_id.clear()
        self.conflicts.clear()

        user_claims: Dict[str, Set[str]] = {}
        for keybinding, keys in self.user_bindings.items():
            if keybinding not in self.definitions:
                continue
            for key in normalize_keys(keys):
                claimants = user_claims.setdefault(key, set())
                claimants.add(keybinding)

        for key, keybindings in user_claims.items():
            if len(keybindings) > 1:
                self.conflicts.append(KeybindingConflict(key, sorted(list(keybindings))))

        for ident, definition in self.definitions.items():
            user_keys = self.user_bindings.get(ident)
            if user_keys is None:
                keys = normalize_keys(definition.default_keys)
            else:
                keys = normalize_keys(user_keys)
            self.keys_by_id[ident] = keys

    def matches(self, data: str, keybinding: str) -> bool:
        keys = self.keys_by_id.get(keybinding, [])
        for key in keys:
            if matches_key(data, key):
                return True
        return False

    def get_keys(self, keybinding: str) -> List[str]:
        return list(self.keys_by_id.get(keybinding, []))

    def get_definition(self, keybinding: str) -> Optional[KeybindingDefinition]:
        return self.definitions.get(keybinding)

    def get_conflicts(self) -> List[KeybindingConflict]:
        return [KeybindingConflict(c.key, list(c.keybindings)) for c in self.conflicts]

    def set_user_bindings(self, user_bindings: Dict[str, Union[str, List[str]]]) -> None:
        self.user_bindings = user_bindings
        self.rebuild()

    def get_user_bindings(self) -> Dict[str, Union[str, List[str]]]:
        return dict(self.user_bindings)

    def get_resolved_bindings(self) -> Dict[str, Union[str, List[str]]]:
        resolved: Dict[str, Union[str, List[str]]] = {}
        for ident in self.definitions.keys():
            keys = self.keys_by_id.get(ident, [])
            resolved[ident] = keys[0] if len(keys) == 1 else list(keys)
        return resolved


_global_keybindings: Optional[KeybindingsManager] = None


def set_keybindings(keybindings: KeybindingsManager) -> None:
    global _global_keybindings
    _global_keybindings = keybindings


def get_keybindings() -> KeybindingsManager:
    global _global_keybindings
    if _global_keybindings is None:
        _global_keybindings = KeybindingsManager(TUI_KEYBINDINGS)
    return _global_keybindings
