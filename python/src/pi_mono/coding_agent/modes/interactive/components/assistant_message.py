"""Assistant message rendering for interactive mode."""

from __future__ import annotations

from typing import Any

from pi_mono.agent.types import AgentMessage
from pi_mono.coding_agent.core.auth_guidance import format_api_error_message
from pi_mono.coding_agent.modes.interactive.theme.theme import get_markdown_theme, theme
from pi_mono.tui.components.markdown import DefaultTextStyle, Markdown
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container

OSC133_ZONE_START = "\x1b]133;A\x07"
OSC133_ZONE_END = "\x1b]133;B\x07"
OSC133_ZONE_FINAL = "\x1b]133;C\x07"


class AssistantMessageComponent(Container):
    """Renders a complete assistant message with markdown and thinking blocks."""

    def __init__(
        self,
        message: AgentMessage | dict[str, Any] | None = None,
        *,
        hide_thinking_block: bool = False,
        hidden_thinking_label: str = "Thinking...",
    ) -> None:
        super().__init__()
        self._content_container = Container()
        self.add_child(self._content_container)
        self._hide_thinking_block = hide_thinking_block
        self._markdown_theme = get_markdown_theme()
        self._hidden_thinking_label = hidden_thinking_label
        self._last_message: AgentMessage | dict[str, Any] | None = None
        self._has_tool_calls = False
        if message is not None:
            self.update_content(message)

    def invalidate(self) -> None:
        super().invalidate()
        if self._last_message is not None:
            self.update_content(self._last_message)

    def set_hide_thinking_block(self, hide: bool) -> None:
        self._hide_thinking_block = hide
        if self._last_message is not None:
            self.update_content(self._last_message)

    def update_content(self, message: AgentMessage | dict[str, Any]) -> None:
        self._last_message = message
        self._content_container.clear()

        content = message.get("content", [])
        has_visible_content = any(
            (block.get("type") == "text" and str(block.get("text", "")).strip())
            or (block.get("type") == "thinking" and str(block.get("thinking", "")).strip())
            for block in content
        )

        if has_visible_content:
            self._content_container.add_child(Spacer(1))

        for index, block in enumerate(content):
            block_type = block.get("type")
            if block_type == "text":
                text = str(block.get("text", "")).strip()
                if text:
                    self._content_container.add_child(Markdown(text, 1, 0, self._markdown_theme))
            elif block_type == "thinking":
                thinking = str(block.get("thinking", "")).strip()
                if not thinking:
                    continue
                has_visible_after = any(
                    (later.get("type") == "text" and str(later.get("text", "")).strip())
                    or (later.get("type") == "thinking" and str(later.get("thinking", "")).strip())
                    for later in content[index + 1 :]
                )
                if self._hide_thinking_block:
                    self._content_container.add_child(
                        Text(
                            theme.italic(theme.fg("thinkingText", self._hidden_thinking_label)),
                            padding_x=1,
                            padding_y=0,
                        )
                    )
                else:
                    self._content_container.add_child(
                        Markdown(
                            thinking,
                            1,
                            0,
                            self._markdown_theme,
                            default_text_style=DefaultTextStyle(
                                color=theme.fg_fn("thinkingText"),
                                italic=True,
                            ),
                        )
                    )
                if has_visible_after:
                    self._content_container.add_child(Spacer(1))

        self._has_tool_calls = any(block.get("type") == "toolCall" for block in content)
        if not self._has_tool_calls:
            stop_reason = message.get("stopReason")
            if stop_reason == "aborted":
                error_message = message.get("errorMessage")
                if error_message and error_message != "Request was aborted":
                    abort_message = str(error_message)
                else:
                    abort_message = "Operation aborted"
                self._content_container.add_child(Spacer(1))
                self._content_container.add_child(
                    Text(theme.fg("error", abort_message), padding_x=1, padding_y=0)
                )
            elif stop_reason == "error":
                error_msg = format_api_error_message(
                    str(message.get("errorMessage") or "Unknown error"),
                    provider=str(message.get("provider") or ""),
                    model_id=str(message.get("model") or ""),
                )
                self._content_container.add_child(Spacer(1))
                self._content_container.add_child(
                    Text(theme.fg("error", error_msg), padding_x=1, padding_y=0)
                )

    def render(self, width: int) -> list[str]:
        lines = super().render(width)
        if self._has_tool_calls or not lines:
            return lines
        lines[0] = OSC133_ZONE_START + lines[0]
        lines[-1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[-1]
        return lines
