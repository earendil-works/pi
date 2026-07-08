"""Branch summary message component."""

from __future__ import annotations

from typing import Any

from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import key_display_text
from pi_mono.coding_agent.modes.interactive.theme.theme import get_markdown_theme, theme
from pi_mono.tui.components.box import Box
from pi_mono.tui.components.markdown import DefaultTextStyle, Markdown
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text


class BranchSummaryMessageComponent(Box):
    def __init__(self, message: dict[str, Any]) -> None:
        super().__init__(1, 1, theme.bg_fn("customMessageBg"))
        self._message = message
        self._expanded = False
        self._update_display()

    def set_expanded(self, expanded: bool) -> None:
        self._expanded = expanded
        self._update_display()

    def invalidate(self) -> None:
        super().invalidate()
        self._update_display()

    def _update_display(self) -> None:
        self.clear()
        label = theme.fg("customMessageLabel", theme.bold("[branch]"))
        self.add_child(Text(label, 0, 0))
        self.add_child(Spacer(1))
        if self._expanded:
            header = "**Branch Summary**\n\n"
            self.add_child(
                Markdown(
                    header + str(self._message.get("summary") or ""),
                    0,
                    0,
                    get_markdown_theme(),
                    DefaultTextStyle(color=theme.fg_fn("customMessageText")),
                )
            )
        else:
            expand_hint = key_display_text("app.tools.expand")
            self.add_child(
                Text(
                    theme.fg("customMessageText", "Branch summary (")
                    + theme.fg("dim", expand_hint)
                    + theme.fg("customMessageText", " to expand)"),
                    0,
                    0,
                )
            )
