"""Editor with coding-agent app keybindings."""

from __future__ import annotations

from collections.abc import Callable

from pi_mono.coding_agent.core.keybindings import CodingAgentKeybindingsManager
from pi_mono.tui.components.editor import Editor, EditorOptions, EditorTheme
from pi_mono.tui.tui import TUI

AppKeybinding = str


class CustomEditor(Editor):
    def __init__(
        self,
        tui: TUI,
        theme: EditorTheme,
        keybindings: CodingAgentKeybindingsManager,
        options: EditorOptions | None = None,
    ) -> None:
        super().__init__(tui, theme, options)
        self._keybindings = keybindings
        self._action_handlers: dict[str, Callable[[], None]] = {}
        self.on_escape: Callable[[], None] | None = None
        self.on_ctrl_d: Callable[[], None] | None = None
        self.on_paste_image: Callable[[], None] | None = None
        self.on_extension_shortcut: Callable[[str], bool] | None = None

    def on_action(self, action: AppKeybinding, handler: Callable[[], None]) -> None:
        self._action_handlers[action] = handler

    def handle_input(self, data: str) -> None:
        if self.on_extension_shortcut and self.on_extension_shortcut(data):
            return
        if self._keybindings.matches(data, "app.clipboard.pasteImage"):
            if self.on_paste_image is not None:
                self.on_paste_image()
            return
        if self._keybindings.matches(data, "app.editor.external"):
            handler = self._action_handlers.get("app.editor.external")
            if handler is not None:
                handler()
            return
        if self._keybindings.matches(data, "app.tools.expand"):
            handler = self._action_handlers.get("app.tools.expand")
            if handler is not None:
                handler()
            return
        if self._keybindings.matches(data, "app.interrupt"):
            if not self.is_showing_autocomplete():
                handler = self.on_escape or self._action_handlers.get("app.interrupt")
                if handler is not None:
                    handler()
                    return
        super().handle_input(data)

    def is_showing_autocomplete(self) -> bool:
        return bool(getattr(self, "_autocomplete_list", None))
