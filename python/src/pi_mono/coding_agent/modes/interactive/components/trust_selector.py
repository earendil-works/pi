"""Project trust selector for interactive mode."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from pi_mono.coding_agent.core.trust_manager import (
    ProjectTrustOption,
    ProjectTrustStoreEntry,
    get_project_trust_options,
)
from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.components.keybinding_hints import (
    key_hint,
    raw_key_hint,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container


@dataclass(frozen=True)
class TrustSelection:
    trusted: bool
    updates: list


def _format_decision(trust_path: str | None, decision: ProjectTrustStoreEntry | None) -> str:
    if decision is None:
        return "none"
    label = "trusted" if decision.decision else "untrusted"
    if trust_path is not None and decision.path != trust_path:
        return f"{label} (inherited from {decision.path})"
    return f"{label} ({decision.path})"


class TrustSelectorComponent(Container):
    def __init__(
        self,
        *,
        cwd: str,
        saved_decision: ProjectTrustStoreEntry | None,
        project_trusted: bool,
        on_select: Callable[[TrustSelection], None],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__()
        self._cwd = cwd
        self._saved_decision = saved_decision
        self._trust_options = get_project_trust_options(cwd, include_session_only=True)
        self._selected_index = max(
            0,
            next(
                (
                    index
                    for index, option in enumerate(self._trust_options)
                    if self._is_saved_option(option)
                ),
                0,
            ),
        )
        self._on_select = on_select
        self._on_cancel = on_cancel
        self._list_container = Container()

        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))
        self.add_child(Text(theme.fg("accent", theme.bold("Project trust")), 1, 0))
        self.add_child(Text(theme.fg("muted", cwd), 1, 0))
        self.add_child(Spacer(1))
        saved_path = self._trust_options[0].saved_path if self._trust_options else None
        self.add_child(
            Text(
                theme.fg(
                    "muted", f"Saved decision: {_format_decision(saved_path, saved_decision)}"
                ),
                1,
                0,
            )
        )
        self.add_child(
            Text(
                theme.fg(
                    "muted",
                    f"Current session: {'trusted' if project_trusted else 'untrusted'}",
                ),
                1,
                0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(self._list_container)
        self.add_child(Spacer(1))
        self.add_child(
            Text(
                raw_key_hint("↑↓", "navigate")
                + "  "
                + key_hint("tui.select.confirm", "save")
                + "  "
                + key_hint("tui.select.cancel", "cancel"),
                1,
                0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())
        self._update_list()

    def _is_saved_option(self, option: ProjectTrustOption) -> bool:
        return (
            option.saved_path is not None
            and self._saved_decision is not None
            and self._saved_decision.decision == option.trusted
            and self._saved_decision.path == option.saved_path
        )

    def _update_list(self) -> None:
        self._list_container.clear()
        for index, option in enumerate(self._trust_options):
            is_selected = index == self._selected_index
            is_current = self._is_saved_option(option)
            checkmark = theme.fg("success", " ✓") if is_current else ""
            prefix = theme.fg("accent", "→ ") if is_selected else "  "
            label = (
                theme.fg("accent", option.label) if is_selected else theme.fg("text", option.label)
            )
            self._list_container.add_child(Text(f"{prefix}{label}{checkmark}", 1, 0))

    def handle_input(self, key_data: str) -> None:
        kb = get_keybindings()
        if kb.matches(key_data, "tui.select.up") or key_data == "k":
            self._selected_index = max(0, self._selected_index - 1)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.down") or key_data == "j":
            self._selected_index = min(len(self._trust_options) - 1, self._selected_index + 1)
            self._update_list()
            return
        if kb.matches(key_data, "tui.select.confirm") or key_data == "\n":
            selected = self._trust_options[self._selected_index]
            self._on_select(
                TrustSelection(trusted=selected.trusted, updates=list(selected.updates))
            )
            return
        if kb.matches(key_data, "tui.select.cancel"):
            self._on_cancel()
