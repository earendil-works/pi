"""Bash execution display for interactive mode."""

from __future__ import annotations

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import key_display_text
from pi_mono.coding_agent.modes.interactive.components.visual_truncate import (
    truncate_to_visual_lines,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.loader import Loader
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.tui import Container, TUI
from pi_mono.utils.ansi import strip_ansi

PREVIEW_LINES = 20


class BashExecutionComponent(Container):
    def __init__(
        self,
        command: str,
        ui: TUI,
        *,
        exclude_from_context: bool = False,
    ) -> None:
        super().__init__()
        self._command = command
        self._output_lines: list[str] = []
        self._status: str = "running"
        self._exit_code: int | None = None
        self._expanded = False
        self._exclude_from_context = exclude_from_context
        self._content_container = Container()
        self._loader = Loader(
            ui,
            lambda spinner: theme.fg("bashMode", spinner),
            lambda text: theme.fg("muted", text),
            f"Running... ({key_display_text('tui.select.cancel')} to cancel)",
        )
        color_key = "dim" if exclude_from_context else "bashMode"
        self._border_color = lambda value: theme.fg(color_key, value)
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder(self._border_color))
        self.add_child(self._content_container)
        self.add_child(DynamicBorder(self._border_color))
        self._update_display()

    def set_expanded(self, expanded: bool) -> None:
        self._expanded = expanded
        self._update_display()

    def invalidate(self) -> None:
        super().invalidate()
        self._update_display()

    def append_output(self, chunk: str) -> None:
        clean = strip_ansi(chunk).replace("\r\n", "\n").replace("\r", "\n")
        new_lines = clean.split("\n")
        if self._output_lines and new_lines:
            self._output_lines[-1] += new_lines[0]
            self._output_lines.extend(new_lines[1:])
        else:
            self._output_lines.extend(new_lines)
        self._update_display()

    def set_complete(
        self,
        exit_code: int | None,
        *,
        cancelled: bool = False,
    ) -> None:
        self._exit_code = exit_code
        if cancelled:
            self._status = "cancelled"
        elif exit_code not in (0, None):
            self._status = "error"
        else:
            self._status = "complete"
        self._loader.stop()
        self._update_display()

    def _update_display(self) -> None:
        self._content_container.clear()
        color_key = "dim" if self._exclude_from_context else "bashMode"
        self._content_container.add_child(
            Text(theme.fg(color_key, theme.bold(f"$ {self._command}")), 1, 0)
        )
        if self._status == "running":
            self._content_container.add_child(self._loader)
            return
        output = "\n".join(line for line in self._output_lines if line is not None)
        if output:
            width = 80
            if self._expanded:
                for line in output.splitlines():
                    self._content_container.add_child(Text(theme.fg("toolOutput", line), 1, 0))
            else:
                truncated = truncate_to_visual_lines(output, PREVIEW_LINES, width, 1)
                for line in truncated.visual_lines:
                    self._content_container.add_child(Text(theme.fg("toolOutput", line), 1, 0))
                if truncated.skipped_count:
                    self._content_container.add_child(
                        Text(
                            theme.fg("muted", f"... {truncated.skipped_count} lines hidden"),
                            1,
                            0,
                        )
                    )
        if self._status == "cancelled":
            self._content_container.add_child(Text(theme.fg("warning", "Cancelled"), 1, 0))
        elif self._status == "error":
            self._content_container.add_child(
                Text(theme.fg("error", f"Exit code {self._exit_code}"), 1, 0)
            )
