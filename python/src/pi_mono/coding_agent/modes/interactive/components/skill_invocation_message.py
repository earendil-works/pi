"""Skill invocation message component for interactive mode."""

from __future__ import annotations

from typing import TypedDict

from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import key_display_text
from pi_mono.coding_agent.modes.interactive.theme.theme import get_markdown_theme, theme
from pi_mono.tui.components.box import Box
from pi_mono.tui.components.markdown import DefaultTextStyle, Markdown
from pi_mono.tui.components.text import Text


class ParsedSkillBlock(TypedDict):
    name: str
    location: str
    content: str
    userMessage: str | None


class SkillInvocationMessageComponent(Box):
    def __init__(self, skill_block: ParsedSkillBlock) -> None:
        super().__init__(1, 1, theme.bg_fn("customMessageBg"))
        self._skill_block = skill_block
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
        if self._expanded:
            label = theme.fg("customMessageLabel", theme.bold("[skill]"))
            self.add_child(Text(label, 0, 0))
            header = f"**{self._skill_block['name']}**\n\n"
            self.add_child(
                Markdown(
                    header + self._skill_block["content"],
                    0,
                    0,
                    get_markdown_theme(),
                    DefaultTextStyle(color=theme.fg_fn("customMessageText")),
                )
            )
            return

        expand_hint = key_display_text("app.tools.expand")
        line = (
            theme.fg("customMessageLabel", theme.bold("[skill] "))
            + theme.fg("customMessageText", self._skill_block["name"])
            + theme.fg("dim", f" ({expand_hint} to expand)")
        )
        self.add_child(Text(line, 0, 0))
