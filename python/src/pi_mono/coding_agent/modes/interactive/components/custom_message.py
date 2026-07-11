"""Custom extension message component for interactive mode."""

from __future__ import annotations

from typing import Any, Callable

from pi_mono.coding_agent.modes.interactive.theme.theme import get_markdown_theme, theme
from pi_mono.tui.components.box import Box
from pi_mono.tui.components.markdown import DefaultTextStyle, Markdown
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container


MessageRenderer = Callable[[dict[str, Any], dict[str, Any], Any], Container | str | None]


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                if text:
                    parts.append(str(text))
        return "\n".join(parts)
    return ""


class CustomMessageComponent(Container):
    def __init__(
        self,
        message: dict[str, Any],
        renderer: MessageRenderer | None = None,
    ) -> None:
        super().__init__()
        self._message = message
        self._renderer = renderer
        self._expanded = False
        self._content_box = Box(1, 1, theme.bg_fn("customMessageBg"))
        self.add_child(Spacer(1))
        self.add_child(self._content_box)
        self._rebuild()

    def set_expanded(self, expanded: bool) -> None:
        if self._expanded != expanded:
            self._expanded = expanded
            self._rebuild()

    def invalidate(self) -> None:
        super().invalidate()
        self._rebuild()

    def _rebuild(self) -> None:
        self._content_box.clear()
        if self._renderer is not None:
            try:
                rendered = self._renderer(
                    self._message,
                    {"expanded": self._expanded},
                    theme,
                )
                if isinstance(rendered, Container):
                    self._content_box.add_child(rendered)
                    return
                if isinstance(rendered, str) and rendered.strip():
                    self._content_box.add_child(Text(rendered, padding_x=0, padding_y=0))
                    return
            except Exception as error:
                self._content_box.add_child(
                    Text(
                        theme.fg("warning", f"[renderer error: {error}]"),
                        padding_x=0,
                        padding_y=0,
                    )
                )
                self._content_box.add_child(Spacer(1))

        custom_type = str(self._message.get("customType", "custom"))
        label = theme.fg("customMessageLabel", theme.bold(f"[{custom_type}]"))
        self._content_box.add_child(Text(label, padding_x=0, padding_y=0))
        self._content_box.add_child(Spacer(1))
        body = _content_to_text(self._message.get("content"))
        if body:
            self._content_box.add_child(
                Markdown(
                    body,
                    0,
                    0,
                    get_markdown_theme(),
                    DefaultTextStyle(color=theme.fg_fn("customMessageText")),
                )
            )
