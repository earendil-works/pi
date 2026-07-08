"""Session selector overlay for interactive mode and CLI resume."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pi_mono.coding_agent.cli.session_format import format_session_date
from pi_mono.coding_agent.modes.interactive.components.session_selector_search import (
    NameFilter,
    SortMode,
    filter_and_sort_sessions,
    has_session_name,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import get_select_list_theme, theme
from pi_mono.tui.components.input import Input
from pi_mono.tui.components.select_list import SelectItem, SelectList
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container, TUI

SessionInfo = dict[str, Any]
SessionScope = Literal["current", "all"]
SessionsLoader = Callable[[Callable[[int, int], None] | None], Awaitable[list[SessionInfo]]]


def _shorten_path(path: str) -> str:
    home = str(Path.home())
    if not path:
        return path
    if path.startswith(home):
        return f"~{path[len(home) :]}"
    return path


def sessions_to_select_items(
    sessions: list[SessionInfo],
    *,
    show_cwd: bool = False,
    show_path: bool = False,
    current_session_path: str | None = None,
) -> list[SelectItem]:
    current_path = os.path.realpath(current_session_path) if current_session_path else None
    items: list[SelectItem] = []
    for session in sessions:
        session_path = str(session.get("path", ""))
        display_text = session.get("name") or session.get("firstMessage") or "(no messages)"
        if isinstance(display_text, str):
            display_text = "".join(
                char if ord(char) >= 32 and ord(char) != 127 else " " for char in display_text
            ).strip()
        else:
            display_text = "(no messages)"

        modified = session.get("modified")
        age = format_session_date(modified) if isinstance(modified, datetime) else ""
        message_count = str(session.get("messageCount", ""))
        right_parts = [message_count, age]
        if show_cwd and session.get("cwd"):
            right_parts.insert(0, _shorten_path(str(session["cwd"])))
        if show_path and session_path:
            right_parts.insert(0, _shorten_path(session_path))
        description = " ".join(part for part in right_parts if part)

        label = str(display_text)
        if current_path and os.path.realpath(session_path) == current_path:
            label = f"{label} (current)"

        items.append(
            SelectItem(
                value=session_path,
                label=label[:80],
                description=description,
            )
        )
    return items


class SessionSelectorComponent(Container):
    """Session picker with scope toggle, search, and optional delete."""

    def __init__(
        self,
        ui: TUI,
        current_sessions_loader: SessionsLoader,
        all_sessions_loader: SessionsLoader,
        on_select: Callable[[str], None],
        on_cancel: Callable[[], None],
        *,
        current_session_path: str | None = None,
        on_exit: Callable[[], None] | None = None,
    ) -> None:
        super().__init__()
        self._ui = ui
        self._current_sessions_loader = current_sessions_loader
        self._all_sessions_loader = all_sessions_loader
        self._on_select = on_select
        self._on_cancel = on_cancel
        self._on_exit = on_exit or on_cancel
        self._current_session_path = current_session_path

        self._scope: SessionScope = "current"
        self._sort_mode: SortMode = "recent"
        self._name_filter: NameFilter = "all"
        self._show_path = False
        self._loading = False
        self._load_progress: tuple[int, int] | None = None
        self._status_message: str | None = None
        self._confirming_delete_path: str | None = None

        self._current_sessions: list[SessionInfo] | None = None
        self._all_sessions: list[SessionInfo] | None = None
        self._current_loading = False
        self._all_loading = False
        self._all_load_seq = 0

        self._header = Text("", padding_x=1, padding_y=0)
        self._hint = Text("", padding_x=1, padding_y=0)
        self.add_child(self._header)
        self.add_child(self._hint)
        self.add_child(Spacer(1))

        self._search_input = Input()
        self._search_input.on_submit = self._select_current
        self.add_child(self._search_input)
        self.add_child(Spacer(1))

        self._select_list = SelectList([], 10, get_select_list_theme())
        self._select_list.on_select = self._handle_select_item
        self._select_list.on_cancel = on_cancel
        self.add_child(self._select_list)

        self._update_header()
        asyncio.create_task(self._load_scope("current", "initial"))

    @property
    def focused(self) -> bool:
        return self._search_input.focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._search_input.focused = value

    def get_session_list(self) -> SelectList:
        return self._select_list

    def _update_header(self) -> None:
        title = (
            "Resume Session (Current Folder)"
            if self._scope == "current"
            else "Resume Session (All)"
        )
        sort_label = {
            "threaded": "Threaded",
            "recent": "Recent",
            "relevance": "Fuzzy",
        }[self._sort_mode]
        name_label = "All" if self._name_filter == "all" else "Named"

        if self._loading:
            progress = (
                f"{self._load_progress[0]}/{self._load_progress[1]}"
                if self._load_progress
                else "..."
            )
            scope_text = f"○ Current Folder | Loading {progress}"
        elif self._scope == "current":
            scope_text = "◉ Current Folder | ○ All"
        else:
            scope_text = "○ Current Folder | ◉ All"

        self._header.text = theme.bold(title)
        self._hint.text = theme.fg(
            "muted",
            f"{scope_text}  Name: {name_label}  Sort: {sort_label}",
        )

        if self._confirming_delete_path is not None:
            self._hint.text = theme.fg("error", "Delete session? Enter to confirm · Esc to cancel")
        elif self._status_message:
            self._hint.text = theme.fg("accent", self._status_message)

    def _active_sessions(self) -> list[SessionInfo]:
        if self._scope == "all":
            return list(self._all_sessions or [])
        return list(self._current_sessions or [])

    def _apply_filter(self) -> None:
        sessions = self._active_sessions()
        if self._name_filter == "named":
            sessions = [session for session in sessions if has_session_name(session)]

        query = self._search_input.get_value()
        if query.strip():
            filtered = filter_and_sort_sessions(sessions, query, self._sort_mode, "all")
        else:
            filtered = list(sessions)
            if self._sort_mode != "threaded":
                filtered.sort(
                    key=lambda session: (
                        session.get("modified").timestamp()
                        if isinstance(session.get("modified"), datetime)
                        else 0.0
                    ),
                    reverse=True,
                )

        show_cwd = self._scope == "all"
        items = sessions_to_select_items(
            filtered,
            show_cwd=show_cwd,
            show_path=self._show_path,
            current_session_path=self._current_session_path,
        )
        self._select_list._items = items  # noqa: SLF001
        self._select_list._filtered_items = list(items)  # noqa: SLF001
        self._select_list.set_selected_index(0)
        self._ui.request_render()

    async def _load_scope(
        self, scope: SessionScope, reason: Literal["initial", "refresh", "toggle"]
    ) -> None:
        if scope == "current":
            self._current_loading = True
        else:
            self._all_loading = True
            self._all_load_seq += 1
        seq = self._all_load_seq if scope == "all" else None

        self._loading = True
        self._load_progress = None
        self._update_header()
        self._ui.request_render()

        def on_progress(loaded: int, total: int) -> None:
            if scope != self._scope:
                return
            if seq is not None and seq != self._all_load_seq:
                return
            self._load_progress = (loaded, total)
            self._update_header()
            self._ui.request_render()

        try:
            loader = (
                self._current_sessions_loader if scope == "current" else self._all_sessions_loader
            )
            sessions = await loader(on_progress)
            if scope == "current":
                self._current_sessions = sessions
                self._current_loading = False
            else:
                self._all_sessions = sessions
                self._all_loading = False

            if scope != self._scope:
                return
            if seq is not None and seq != self._all_load_seq:
                return

            self._loading = False
            self._apply_filter()
            self._update_header()
            self._ui.request_render()

            if scope == "all" and not sessions and not (self._current_sessions or []):
                if reason == "initial":
                    self._on_exit()
        except Exception as error:
            if scope == "current":
                self._current_loading = False
            else:
                self._all_loading = False
            if scope != self._scope:
                return
            if seq is not None and seq != self._all_load_seq:
                return
            self._loading = False
            self._status_message = f"Failed to load sessions: {error}"
            if reason == "initial":
                self._current_sessions = self._current_sessions or []
                self._all_sessions = self._all_sessions or []
                self._apply_filter()
            self._update_header()
            self._ui.request_render()

    def _toggle_scope(self) -> None:
        if self._scope == "current":
            self._scope = "all"
            if self._all_sessions is not None:
                self._loading = False
                self._apply_filter()
                self._update_header()
                self._ui.request_render()
                return
            if not self._all_loading:
                asyncio.create_task(self._load_scope("all", "toggle"))
        else:
            self._scope = "current"
            self._loading = self._current_loading
            self._apply_filter()
        self._update_header()
        self._ui.request_render()

    def _toggle_sort_mode(self) -> None:
        self._sort_mode = "relevance" if self._sort_mode == "recent" else "recent"
        self._apply_filter()
        self._update_header()

    def _toggle_name_filter(self) -> None:
        self._name_filter = "named" if self._name_filter == "all" else "all"
        self._apply_filter()
        self._update_header()

    def _toggle_path(self) -> None:
        self._show_path = not self._show_path
        self._apply_filter()

    def _is_current_session_path(self, path: str) -> bool:
        if not self._current_session_path:
            return False
        return os.path.realpath(path) == os.path.realpath(self._current_session_path)

    def _start_delete_confirmation(self) -> None:
        selected = self._select_list.get_selected_item()
        if not selected or not selected.value:
            return
        if self._is_current_session_path(selected.value):
            self._status_message = "Cannot delete the currently active session"
            self._update_header()
            self._ui.request_render()
            return
        self._confirming_delete_path = selected.value
        self._update_header()
        self._ui.request_render()

    async def _delete_session(self, session_path: str) -> None:
        try:
            os.remove(session_path)
            self._status_message = "Session deleted"
            if self._current_sessions is not None:
                self._current_sessions = [
                    s for s in self._current_sessions if s.get("path") != session_path
                ]
            if self._all_sessions is not None:
                self._all_sessions = [
                    s for s in self._all_sessions if s.get("path") != session_path
                ]
            self._apply_filter()
            await self._load_scope(self._scope, "refresh")
        except OSError as error:
            self._status_message = f"Failed to delete: {error}"
        self._confirming_delete_path = None
        self._update_header()
        self._ui.request_render()

    def _select_current(self) -> None:
        selected = self._select_list.get_selected_item()
        if selected and selected.value:
            self._on_select(selected.value)

    def _handle_select_item(self, item: SelectItem) -> None:
        if item.value:
            self._on_select(item.value)

    def handle_input(self, data: str) -> None:
        kb = get_keybindings()

        if self._confirming_delete_path is not None:
            if kb.matches(data, "tui.select.confirm"):
                path = self._confirming_delete_path
                self._confirming_delete_path = None
                asyncio.create_task(self._delete_session(path))
                return
            if kb.matches(data, "tui.select.cancel"):
                self._confirming_delete_path = None
                self._update_header()
                self._ui.request_render()
            return

        if kb.matches(data, "tui.input.tab"):
            self._toggle_scope()
            return
        if kb.matches(data, "app.session.toggleSort"):
            self._toggle_sort_mode()
            return
        if kb.matches(data, "app.session.toggleNamedFilter"):
            self._toggle_name_filter()
            return
        if kb.matches(data, "app.session.togglePath"):
            self._toggle_path()
            return
        if kb.matches(data, "app.session.delete"):
            self._start_delete_confirmation()
            return
        if kb.matches(data, "app.session.deleteNoninvasive"):
            if self._search_input.get_value():
                self._search_input.handle_input(data)
                self._apply_filter()
                return
            self._start_delete_confirmation()
            return
        if kb.matches(data, "tui.select.up") or kb.matches(data, "tui.select.down"):
            self._select_list.handle_input(data)
            return
        if kb.matches(data, "tui.select.confirm"):
            self._select_list.handle_input(data)
            return
        if kb.matches(data, "tui.select.cancel"):
            self._on_cancel()
            return

        self._search_input.handle_input(data)
        self._apply_filter()
