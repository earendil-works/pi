"""User message selector for session forking."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from pi_mono.coding_agent.modes.interactive.components.dynamic_border import DynamicBorder
from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.components.spacer import Spacer
from pi_mono.tui.components.text import Text
from pi_mono.tui.editor_component import Component
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import Container
from pi_mono.tui.utils import truncate_to_width


@dataclass(frozen=True)
class UserMessageItem:
    id: str
    text: str
    timestamp: str | None = None


class UserMessageList(Component):
    def __init__(
        self,
        messages: list[UserMessageItem],
        initial_selected_id: str | None = None,
    ) -> None:
        self._messages = list(messages)
        self._selected_index = 0
        self.on_select: Callable[[str], None] | None = None
        self.on_cancel: Callable[[], None] | None = None
        self._max_visible = 10

        if initial_selected_id is not None:
            for index, message in enumerate(self._messages):
                if message.id == initial_selected_id:
                    self._selected_index = index
                    break
        elif self._messages:
            self._selected_index = len(self._messages) - 1

    def invalidate(self) -> None:
        pass

    def render(self, width: int) -> list[str]:
        lines: list[str] = []
        if not self._messages:
            lines.append(theme.fg("muted", "  No user messages found"))
            return lines

        start_index = max(
            0,
            min(
                self._selected_index - self._max_visible // 2,
                len(self._messages) - self._max_visible,
            ),
        )
        end_index = min(start_index + self._max_visible, len(self._messages))

        for index in range(start_index, end_index):
            message = self._messages[index]
            is_selected = index == self._selected_index
            normalized_message = " ".join(message.text.replace("\n", " ").split())
            cursor = theme.fg("accent", "› ") if is_selected else "  "
            max_msg_width = max(1, width - 2)
            truncated_msg = truncate_to_width(normalized_message, max_msg_width)
            message_line = cursor + (theme.bold(truncated_msg) if is_selected else truncated_msg)
            lines.append(message_line)
            metadata = f"  Message {index + 1} of {len(self._messages)}"
            lines.append(theme.fg("muted", metadata))
            lines.append("")

        if start_index > 0 or end_index < len(self._messages):
            lines.append(theme.fg("muted", f"  ({self._selected_index + 1}/{len(self._messages)})"))

        return lines

    def handle_input(self, key_data: str) -> None:
        kb = get_keybindings()
        if kb.matches(key_data, "tui.select.up"):
            if self._selected_index == 0:
                self._selected_index = len(self._messages) - 1
            else:
                self._selected_index -= 1
            return
        if kb.matches(key_data, "tui.select.down"):
            if self._selected_index == len(self._messages) - 1:
                self._selected_index = 0
            else:
                self._selected_index += 1
            return
        if kb.matches(key_data, "tui.select.confirm"):
            selected = self._messages[self._selected_index]
            if self.on_select is not None:
                self.on_select(selected.id)
            return
        if kb.matches(key_data, "tui.select.cancel") and self.on_cancel is not None:
            self.on_cancel()


class UserMessageSelectorComponent(Container):
    def __init__(
        self,
        messages: list[dict[str, str]],
        on_select: Callable[[str], None],
        on_cancel: Callable[[], None],
        initial_selected_id: str | None = None,
    ) -> None:
        super().__init__()
        items = [
            UserMessageItem(
                id=str(message.get("id") or message["entryId"]),
                text=message["text"],
            )
            for message in messages
        ]

        self.add_child(Spacer(1))
        self.add_child(Text(theme.bold("Fork from Message"), padding_x=1, padding_y=0))
        self.add_child(
            Text(
                theme.fg(
                    "muted",
                    "Select a user message to copy the active path up to that point into a new session",
                ),
                padding_x=1,
                padding_y=0,
            )
        )
        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())
        self.add_child(Spacer(1))

        self._message_list = UserMessageList(items, initial_selected_id)
        self._message_list.on_select = on_select
        self._message_list.on_cancel = on_cancel
        self.add_child(self._message_list)

        self.add_child(Spacer(1))
        self.add_child(DynamicBorder())

    def get_message_list(self) -> UserMessageList:
        return self._message_list

    def handle_input(self, data: str) -> None:
        self._message_list.handle_input(data)
