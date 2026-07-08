"""Tool execution display for interactive mode."""

from __future__ import annotations

from typing import Any

from pi_mono.coding_agent.core.tools.tool_renderers import render_tool_call, render_tool_result
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.box import Box
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container, TUI


class ToolExecutionComponent(Container):
    def __init__(
        self,
        tool_name: str,
        tool_call_id: str,
        args: Any,
        *,
        ui: TUI | None = None,
        cwd: str | None = None,
        show_images: bool = True,
    ) -> None:
        super().__init__()
        del ui
        self._tool_name = tool_name
        self._tool_call_id = tool_call_id
        self._args = args
        self._cwd = cwd or "."
        self._show_images = show_images
        self._expanded = False
        self._is_partial = True
        self._is_error = False
        self._result: dict[str, Any] | None = None
        self._content_box = Box(1, 1, theme.bg_fn("toolPendingBg"))
        self.add_child(Spacer(1))
        self.add_child(self._content_box)
        self._update_display()

    @property
    def tool_call_id(self) -> str:
        return self._tool_call_id

    def update_args(self, args: Any) -> None:
        self._args = args
        self._update_display()

    def mark_execution_started(self) -> None:
        self._update_display()

    def set_args_complete(self) -> None:
        self._update_display()

    def update_result(self, result: dict[str, Any], is_partial: bool = False) -> None:
        self._result = result
        self._is_partial = is_partial
        self._is_error = bool(result.get("isError"))
        self._update_display()

    def set_expanded(self, expanded: bool) -> None:
        self._expanded = expanded
        self._update_display()

    def invalidate(self) -> None:
        super().invalidate()
        self._update_display()

    def _update_display(self) -> None:
        if self._is_partial:
            bg_fn = theme.bg_fn("toolPendingBg")
        elif self._is_error:
            bg_fn = theme.bg_fn("toolErrorBg")
        else:
            bg_fn = theme.bg_fn("toolSuccessBg")
        self._content_box.set_bg_fn(bg_fn)
        self._content_box.clear()

        call_text = render_tool_call(
            self._tool_name,
            self._args,
            self._cwd,
            expanded=self._expanded,
        )
        self._content_box.add_child(Text(call_text, padding_x=0, padding_y=0))

        if self._result is not None:
            result_text = render_tool_result(
                self._tool_name,
                self._args,
                self._result,
                self._cwd,
                expanded=self._expanded,
                is_error=self._is_error,
                show_images=self._show_images,
            )
            if result_text:
                self._content_box.add_child(Text(result_text, padding_x=0, padding_y=0))
