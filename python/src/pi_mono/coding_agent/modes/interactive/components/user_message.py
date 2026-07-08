"""User message component for interactive mode."""

from __future__ import annotations

from pi_mono.coding_agent.modes.interactive.theme.theme import get_markdown_theme, theme
from pi_mono.tui.components.box import Box
from pi_mono.tui.components.markdown import DefaultTextStyle, Markdown
from pi_mono.tui.tui import Container

OSC133_ZONE_START = "\x1b]133;A\x07"
OSC133_ZONE_END = "\x1b]133;B\x07"
OSC133_ZONE_FINAL = "\x1b]133;C\x07"


class UserMessageComponent(Container):
    def __init__(self, text: str) -> None:
        super().__init__()
        content_box = Box(1, 1, theme.bg_fn("userMessageBg"))
        content_box.add_child(
            Markdown(
                text,
                0,
                0,
                get_markdown_theme(),
                DefaultTextStyle(color=theme.fg_fn("userMessageText")),
            )
        )
        self.add_child(content_box)

    def render(self, width: int) -> list[str]:
        lines = super().render(width)
        if not lines:
            return lines
        lines[0] = OSC133_ZONE_START + lines[0]
        lines[-1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[-1]
        return lines
