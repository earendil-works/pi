"""Editor component - multi-line text editor with autocomplete and syntax highlighting"""

import re
import asyncio
from dataclasses import dataclass
from typing import Dict, List, Optional, Any, Tuple, Set, Callable

from pi_mono.tui.autocomplete import AutocompleteProvider
from pi_mono.tui.keys import decode_printable_key
from pi_mono.tui.tui import CURSOR_MARKER
from pi_mono.tui.utils import truncate_to_width, visible_width, wrap_text_with_ansi
from pi_mono.tui.kill_ring import KillRing
from pi_mono.tui.keybindings import get_keybindings
from pi_mono.tui.tui import TUI
from pi_mono.tui.undo_stack import UndoStack
from pi_mono.tui.utils import (
    grapheme_segment,
)
from pi_mono.tui.word_navigation import find_word_backward, find_word_forward
from pi_mono.tui.components.select_list import SelectList, SelectListTheme, SelectListLayoutOptions

# Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`.
PASTE_MARKER_REGEX = re.compile(r"\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]")

# Non-global version for single-segment testing.
PASTE_MARKER_SINGLE = re.compile(r"^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$")


def is_paste_marker(segment: str) -> bool:
    """Check if a segment is a paste marker (i.e. was merged by segment_with_markers)."""
    return len(segment) >= 10 and PASTE_MARKER_SINGLE.match(segment) is not None


def segment_with_markers(
    text: str,
    base_segmenter,
    valid_ids: Set[int],
) -> List[str]:
    """A segmenter that merges graphemes that fall within paste markers into single atomic segments."""
    # Fast path: no paste markers in the text or no valid IDs.
    if not valid_ids or "[paste #" not in text:
        return list(base_segmenter(text))

    # Find all marker spans with valid IDs.
    markers: List[Tuple[int, int]] = []
    for match in PASTE_MARKER_REGEX.finditer(text):
        id_val = int(match.group(1))
        if id_val not in valid_ids:
            continue
        markers.append((match.start(), match.end()))

    if not markers:
        return list(base_segmenter(text))

    # Build merged segment list.
    base_segments = list(base_segmenter(text))
    result: List[str] = []
    marker_idx = 0

    for seg in base_segments:
        # Skip past markers that are entirely before this segment.
        while marker_idx < len(markers) and markers[marker_idx][1] <= seg.index:
            marker_idx += 1

        marker = markers[marker_idx] if marker_idx < len(markers) else None

        if marker and seg.index >= marker[0] and seg.index < marker[1]:
            # This segment falls inside a marker.
            # If this is the first segment of the marker, emit a merged segment.
            if seg.index == marker[0]:
                marker_text = text[marker[0] : marker[1]]
                result.append(marker_text)
            # Otherwise skip (already merged into the first segment).
        else:
            result.append(seg.segment)

    return result


class EditorState:
    """Internal editor state"""

    def __init__(self):
        self.lines: List[str] = [""]
        self.cursor_line: int = 0
        self.cursor_col: int = 0


class LayoutLine:
    """A laid-out line with cursor info"""

    def __init__(self, text: str, has_cursor: bool = False, cursor_pos: Optional[int] = None):
        self.text = text
        self.has_cursor = has_cursor
        self.cursor_pos = cursor_pos


class EditorTheme:
    """Editor theme"""

    def __init__(
        self,
        border_color: Callable[[str], str],
        select_list: SelectListTheme,
    ):
        self.border_color = border_color
        self.select_list = select_list


class EditorOptions:
    """Editor options"""

    def __init__(
        self,
        padding_x: int = 0,
        autocomplete_max_visible: int = 5,
    ):
        self.padding_x = padding_x
        self.autocomplete_max_visible = autocomplete_max_visible


# Kitty CSI-u sequences for printable keys
SLASH_COMMAND_SELECT_LIST_LAYOUT = SelectListLayoutOptions(
    min_primary_column_width=12,
    max_primary_column_width=32,
)

ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20


@dataclass
class _LayoutLine:
    text: str
    has_cursor: bool = False
    cursor_pos: int | None = None


class Editor:
    """Multi-line text editor with autocomplete, history, kill ring, and syntax highlighting"""

    def __init__(
        self,
        tui: TUI,
        theme: EditorTheme,
        options: Optional[EditorOptions] = None,
    ) -> None:
        self.tui = tui
        self.theme = theme
        self.border_color = theme.border_color
        self._options = options or EditorOptions()

        self._state = EditorState()
        self._scroll_offset = 0
        self._padding_x = self._options.padding_x
        self._last_width = 80
        self._focused = False

        # Autocomplete
        self._autocomplete_provider: Optional[AutocompleteProvider] = None
        self._autocomplete_list: Optional[SelectList] = None
        self._autocomplete_state: Optional[str] = None  # "regular", "force", None
        self._autocomplete_prefix = ""
        self._autocomplete_max_visible = self._options.autocomplete_max_visible
        self._autocomplete_abort: Optional[Any] = None
        self._autocomplete_debounce_task: Optional[asyncio.Task] = None
        self._autocomplete_request_id = 0
        self._autocomplete_start_token = 0
        self._autocomplete_prefix = ""

        # Paste tracking
        self._pastes: Dict[int, str] = {}
        self._paste_counter = 0
        self._paste_buffer = ""
        self._is_in_paste = False

        # History
        self._history: List[str] = []
        self._history_index = -1
        self._history_draft: EditorState | None = None

        # Kill ring
        self._kill_ring = KillRing()
        self._last_action: Optional[str] = None

        # Jump mode
        self._jump_mode: Optional[str] = None  # "forward", "backward", None

        # Sticky column for vertical movement
        self._preferred_visual_col: Optional[int] = None
        self._snapped_from_cursor_col: Optional[int] = None

        # Undo
        self._undo_stack = UndoStack[EditorState]()

        # Callbacks
        self.on_submit: Optional[Callable[[str], None]] = None
        self.on_change: Optional[Callable[[str], None]] = None
        self.disable_submit = False

    # =========================================================================
    # EditorComponent protocol methods
    # =========================================================================

    def get_text(self) -> str:
        return "\n".join(self._state.lines)

    def set_text(self, text: str) -> None:
        lines = text.split("\n")
        self._state.lines = lines if lines else [""]
        self._state.cursor_line = len(self._state.lines) - 1
        self._state.cursor_col = len(self._state.lines[-1]) if self._state.lines else 0
        self._scroll_offset = 0
        if self.on_change:
            self.on_change(self.get_text())

    def handle_input(self, data: str) -> None:
        """Handle keyboard input - main entry point"""
        self._handle_input_internal(data)

    def invalidate(self) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False

    def add_to_history(self, text: str) -> None:
        """Add a prompt to history for up/down arrow navigation."""
        trimmed = text.strip()
        if not trimmed:
            return
        if self._history and self._history[0] == trimmed:
            return
        self._history.insert(0, trimmed)
        if len(self._history) > 100:
            self._history.pop()

    def insert_text_at_cursor(self, text: str) -> None:
        """Insert text at cursor position."""
        self._insert_text(text)

    def get_expanded_text(self) -> str:
        """Get text with any markers expanded."""
        return self.get_text()

    def set_autocomplete_provider(self, provider: Any) -> None:
        self.cancel_autocomplete()
        self._autocomplete_provider = provider

    def set_padding_x(self, padding: int) -> None:
        new_padding = max(0, int(padding))
        if self._padding_x != new_padding:
            self._padding_x = new_padding
            self.tui.request_render()

    def set_autocomplete_max_visible(self, max_visible: int) -> None:
        new_max = max(3, min(20, int(max_visible)))
        if self._autocomplete_max_visible != new_max:
            self._autocomplete_max_visible = new_max
            self.tui.request_render()

    @property
    def focused(self) -> bool:
        return self._focused

    @focused.setter
    def focused(self, value: bool) -> None:
        self._focused = value
        if not value:
            self.cancel_autocomplete()

    # =========================================================================
    # Internal input handling
    # =========================================================================

    def _handle_input_internal(self, data: str) -> None:
        """Main input handler - delegates to autocomplete if active, otherwise handles editor keys"""
        kb = get_keybindings()

        # Character jump mode
        if self._jump_mode is not None:
            if kb.matches(data, "tui.editor.jumpForward") or kb.matches(
                data, "tui.editor.jumpBackward"
            ):
                self._jump_mode = None
                return

            printable = decode_printable_key(data) or (data if ord(data[0]) >= 32 else None)
            if printable is not None:
                self._jump_mode = None
                self._jump_to_char(printable, self._jump_mode)
                return

            self._jump_mode = None
            # Fall through to normal handling

        # Bracketed paste mode
        if "\x1b[200~" in data:
            self._is_in_paste = True
            self._paste_buffer = ""
            data = data.replace("\x1b[200~", "")

        if self._is_in_paste:
            self._paste_buffer += data
            end_idx = self._paste_buffer.find("\x1b[201~")
            if end_idx != -1:
                paste_content = self._paste_buffer[:end_idx]
                if paste_content:
                    self._handle_paste(paste_content)
                self._is_in_paste = False
                remaining = self._paste_buffer[end_idx + 6 :]
                self._paste_buffer = ""
                if remaining:
                    self._handle_input_internal(remaining)
                return
            return

        # If autocomplete is showing, let it handle first
        if self._autocomplete_list and self._autocomplete_state:
            if self._autocomplete_list.handle_input(data):
                self.tui.request_render()
                return

        # Editor keybindings
        if kb.matches(data, "tui.select.cancel"):
            if self._history_index >= 0:
                self._history_index = -1
                self._set_text_internal("")
            elif self._autocomplete_state:
                self.cancel_autocomplete()
            return

        if kb.matches(data, "tui.editor.undo"):
            self._undo()
            return

        if (kb.matches(data, "tui.input.submit") or data == "\n") and not self.disable_submit:
            if self._autocomplete_state:
                self._accept_autocomplete()
                return
            if self.on_submit:
                self.on_submit(self.get_text())
            self._history_index = -1
            self._history_draft = None
            return

        if kb.matches(data, "tui.input.tab"):
            self._trigger_autocomplete(force=True, explicit_tab=True)
            return

        # Movement keys
        if kb.matches(data, "tui.editor.cursorLeft"):
            self._move_cursor_left()
            return
        if kb.matches(data, "tui.editor.cursorRight"):
            self._move_cursor_right()
            return
        if kb.matches(data, "tui.editor.cursorUp"):
            if self._is_on_first_visual_line() and (
                self._is_editor_empty()
                or self._history_index > -1
                or self._state.cursor_col == 0
            ):
                self._history_up()
            elif self._is_on_first_visual_line():
                self._state.cursor_col = 0
            else:
                self._move_cursor_up()
            return
        if kb.matches(data, "tui.editor.cursorDown"):
            if self._history_index > -1 and self._is_on_last_visual_line():
                self._history_down()
            elif self._is_on_last_visual_line():
                self._state.cursor_col = len(self._state.lines[self._state.cursor_line])
            else:
                self._move_cursor_down()
            return
        if kb.matches(data, "tui.editor.cursorLineStart"):
            self._state.cursor_col = 0
            return
        if kb.matches(data, "tui.editor.cursorLineEnd"):
            self._state.cursor_col = len(self._state.lines[self._state.cursor_line])
            return
        if kb.matches(data, "tui.editor.cursorWordLeft"):
            self._move_word_left()
            return
        if kb.matches(data, "tui.editor.cursorWordRight"):
            self._move_word_right()
            return
        if kb.matches(data, "tui.editor.jumpForward"):
            self._jump_mode = "forward"
            return
        if kb.matches(data, "tui.editor.jumpBackward"):
            self._jump_mode = "backward"
            return

        # Deletion
        if kb.matches(data, "tui.editor.deleteCharBackward"):
            self._backspace()
            return
        if kb.matches(data, "tui.editor.deleteCharForward"):
            self._delete_forward()
            return
        if kb.matches(data, "tui.editor.deleteWordBackward"):
            self._delete_word_backward()
            return
        if kb.matches(data, "tui.editor.deleteWordForward"):
            self._delete_word_forward()
            return
        if kb.matches(data, "tui.editor.deleteToLineStart"):
            self._kill_to_line_start()
            return
        if kb.matches(data, "tui.editor.deleteToLineEnd"):
            self._kill_to_line_end()
            return

        # Kill ring
        if kb.matches(data, "tui.editor.yank"):
            self._yank()
            return
        if kb.matches(data, "tui.editor.yankPop"):
            self._yank_pop()
            return

        # Kitty CSI-u printable
        kitty_printable = decode_printable_key(data)
        if kitty_printable:
            self._insert_text(kitty_printable)
            return

        # Regular printable
        if data and data[0] >= " ":
            self._insert_text(data)

    # =========================================================================
    # Text manipulation
    # =========================================================================

    def _insert_text(self, text: str) -> None:
        """Insert text at cursor position"""
        self._push_undo()
        line = self._state.lines[self._state.cursor_line]
        self._state.lines[self._state.cursor_line] = (
            line[: self._state.cursor_col] + text + line[self._state.cursor_col :]
        )
        self._state.cursor_col += len(text)
        self._last_action = "type"
        if self.on_change:
            self.on_change(self.get_text())
        self._request_autocomplete(force=False, explicit_tab=False)
        self.tui.request_render()

    def _backspace(self) -> None:
        """Delete character before cursor"""
        if self._state.cursor_col == 0:
            if self._state.cursor_line > 0:
                self._push_undo()
                prev_line = self._state.lines[self._state.cursor_line - 1]
                self._state.cursor_col = len(prev_line)
                self._state.lines[self._state.cursor_line - 1] = (
                    prev_line + self._state.lines[self._state.cursor_line]
                )
                del self._state.lines[self._state.cursor_line]
                self._state.cursor_line -= 1
        else:
            self._push_undo()
            line = self._state.lines[self._state.cursor_line]
            # Delete grapheme
            graphemes = list(grapheme_segment(line[: self._state.cursor_col]))
            if graphemes:
                grapheme_len = len(graphemes[-1])
                self._state.lines[self._state.cursor_line] = (
                    line[: self._state.cursor_col - grapheme_len] + line[self._state.cursor_col :]
                )
                self._state.cursor_col -= grapheme_len
        self.tui.request_render()

    def _delete_forward(self) -> None:
        """Delete character after cursor"""
        line = self._state.lines[self._state.cursor_line]
        if self._state.cursor_col >= len(line):
            # At end of line - join with next
            if self._state.cursor_line + 1 < len(self._state.lines):
                self._push_undo()
                self._state.lines[self._state.cursor_line] = (
                    line + self._state.lines[self._state.cursor_line + 1]
                )
                del self._state.lines[self._state.cursor_line + 1]
        else:
            self._push_undo()
            graphemes = list(grapheme_segment(line[self._state.cursor_col :]))
            if graphemes:
                grapheme_len = len(graphemes[0])
                self._state.lines[self._state.cursor_line] = (
                    line[: self._state.cursor_col] + line[self._state.cursor_col + grapheme_len :]
                )
        self.tui.request_render()

    def _delete_word_backward(self) -> None:
        """Delete word backward"""
        if self._state.cursor_col == 0 and self._state.cursor_line == 0:
            return
        self._push_undo()
        line = self._state.lines[self._state.cursor_line]
        pos = find_word_backward(line, self._state.cursor_col)
        self._state.lines[self._state.cursor_line] = line[:pos] + line[self._state.cursor_col :]
        self._state.cursor_col = pos
        self.tui.request_render()

    def _delete_word_forward(self) -> None:
        """Delete word forward"""
        line = self._state.lines[self._state.cursor_line]
        if self._state.cursor_col >= len(line):
            return
        self._push_undo()
        pos = find_word_forward(line, self._state.cursor_col)
        self._state.lines[self._state.cursor_line] = line[: self._state.cursor_col] + line[pos:]
        self.tui.request_render()

    def _kill_to_line_start(self) -> None:
        """Kill from cursor to line start"""
        self._history_index = -1
        line = self._state.lines[self._state.cursor_line]
        if self._state.cursor_col > 0:
            self._push_undo()
            deleted = line[: self._state.cursor_col]
            self._kill_ring.push(deleted, prepend=True, accumulate=self._last_action == "kill")
            self._last_action = "kill"
            self._state.lines[self._state.cursor_line] = line[self._state.cursor_col :]
            self._state.cursor_col = 0
        elif self._state.cursor_line > 0:
            self._push_undo()
            self._kill_ring.push("\n", prepend=True, accumulate=self._last_action == "kill")
            self._last_action = "kill"
            previous_line = self._state.lines[self._state.cursor_line - 1]
            self._state.lines[self._state.cursor_line - 1] = previous_line + line
            del self._state.lines[self._state.cursor_line]
            self._state.cursor_line -= 1
            self._state.cursor_col = len(previous_line)
        if self.on_change:
            self.on_change(self.get_text())
        self.tui.request_render()

    def _kill_to_line_end(self) -> None:
        """Kill from cursor to line end"""
        self._history_index = -1
        line = self._state.lines[self._state.cursor_line]
        if self._state.cursor_col < len(line):
            self._push_undo()
            deleted = line[self._state.cursor_col :]
            self._kill_ring.push(deleted, accumulate=self._last_action == "kill")
            self._last_action = "kill"
            self._state.lines[self._state.cursor_line] = line[: self._state.cursor_col]
        elif self._state.cursor_line + 1 < len(self._state.lines):
            self._push_undo()
            self._kill_ring.push("\n", accumulate=self._last_action == "kill")
            self._last_action = "kill"
            next_line = self._state.lines[self._state.cursor_line + 1]
            self._state.lines[self._state.cursor_line] = line + next_line
            del self._state.lines[self._state.cursor_line + 1]
        if self.on_change:
            self.on_change(self.get_text())
        self.tui.request_render()

    def _yank(self) -> None:
        text = self._kill_ring.peek()
        if not text:
            return
        self._push_undo()
        self._insert_yanked_text(text)
        self._last_action = "yank"

    def _yank_pop(self) -> None:
        if self._last_action != "yank" or self._kill_ring.length <= 1:
            return
        self._push_undo()
        self._delete_yanked_text()
        self._kill_ring.rotate()
        text = self._kill_ring.peek()
        if text:
            self._insert_yanked_text(text)
        self._last_action = "yank"

    def _insert_yanked_text(self, text: str) -> None:
        self._history_index = -1
        lines = text.split("\n")
        if len(lines) == 1:
            line = self._state.lines[self._state.cursor_line]
            self._state.lines[self._state.cursor_line] = (
                line[: self._state.cursor_col] + text + line[self._state.cursor_col :]
            )
            self._state.cursor_col += len(text)
        else:
            line = self._state.lines[self._state.cursor_line]
            before = line[: self._state.cursor_col]
            after = line[self._state.cursor_col :]
            self._state.lines[self._state.cursor_line] = before + (lines[0] or "")
            for index in range(1, len(lines) - 1):
                self._state.lines.insert(self._state.cursor_line + index, lines[index] or "")
            last_index = self._state.cursor_line + len(lines) - 1
            self._state.lines.insert(last_index, (lines[-1] or "") + after)
            self._state.cursor_line = last_index
            self._state.cursor_col = len(lines[-1] or "")
        if self.on_change:
            self.on_change(self.get_text())
        self.tui.request_render()

    def _delete_yanked_text(self) -> None:
        yanked_text = self._kill_ring.peek()
        if not yanked_text:
            return
        yank_lines = yanked_text.split("\n")
        if len(yank_lines) == 1:
            line = self._state.lines[self._state.cursor_line]
            delete_len = len(yanked_text)
            self._state.lines[self._state.cursor_line] = (
                line[: self._state.cursor_col - delete_len] + line[self._state.cursor_col :]
            )
            self._state.cursor_col -= delete_len
        else:
            start_line = self._state.cursor_line - (len(yank_lines) - 1)
            start_col = len(self._state.lines[start_line]) - len(yank_lines[0] or "")
            after_cursor = self._state.lines[self._state.cursor_line][self._state.cursor_col :]
            before_yank = self._state.lines[start_line][:start_col]
            self._state.lines[start_line : self._state.cursor_line + 1] = [
                before_yank + after_cursor
            ]
            self._state.cursor_line = start_line
            self._state.cursor_col = start_col
        if self.on_change:
            self.on_change(self.get_text())
        self.tui.request_render()

    def _handle_paste(self, pasted_text: str) -> None:
        self.cancel_autocomplete()
        self._history_index = -1
        self._last_action = None
        self._push_undo()
        clean_text = pasted_text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
        filtered = "".join(char for char in clean_text if char == "\n" or ord(char) >= 32)
        if "\n" in filtered:
            parts = filtered.split("\n")
            line = self._state.lines[self._state.cursor_line]
            before = line[: self._state.cursor_col]
            after = line[self._state.cursor_col :]
            self._state.lines[self._state.cursor_line] = before + parts[0]
            for index, part in enumerate(parts[1:-1], start=1):
                self._state.lines.insert(self._state.cursor_line + index, part)
            last_index = self._state.cursor_line + len(parts) - 1
            self._state.lines.insert(last_index, parts[-1] + after)
            self._state.cursor_line = last_index
            self._state.cursor_col = len(parts[-1])
        else:
            line = self._state.lines[self._state.cursor_line]
            self._state.lines[self._state.cursor_line] = (
                line[: self._state.cursor_col] + filtered + line[self._state.cursor_col :]
            )
            self._state.cursor_col += len(filtered)
            if self.on_change:
                self.on_change(self.get_text())
            self.tui.request_render()
            return
        if self.on_change:
            self.on_change(self.get_text())
        self.tui.request_render()

    def _push_undo(self) -> None:
        self._undo_stack.push(self._state)

    def _undo(self) -> None:
        snapshot = self._undo_stack.pop()
        if snapshot is None:
            return
        self._history_index = -1
        self._state.lines = list(snapshot.lines)
        self._state.cursor_line = snapshot.cursor_line
        self._state.cursor_col = snapshot.cursor_col
        self._last_action = None
        self._preferred_visual_col = None
        if self.on_change:
            self.on_change(self.get_text())
        self.tui.request_render()

    def cancel_autocomplete(self) -> None:
        if self._autocomplete_debounce_task is not None:
            self._autocomplete_debounce_task.cancel()
            self._autocomplete_debounce_task = None
        if self._autocomplete_abort is not None:
            abort = self._autocomplete_abort
            if hasattr(abort, "abort"):
                abort.abort()
            self._autocomplete_abort = None
        self._autocomplete_state = None
        self._autocomplete_list = None

    def _get_best_autocomplete_match_index(self, items: list[Any], prefix: str) -> int:
        if not prefix:
            return -1
        first_prefix_index = -1
        for index, item in enumerate(items):
            value = item.value if hasattr(item, "value") else str(item)
            if value == prefix:
                return index
            if first_prefix_index == -1 and value.startswith(prefix):
                first_prefix_index = index
        return first_prefix_index

    def _create_autocomplete_list(self, prefix: str, items: list[Any]) -> SelectList:
        layout = SLASH_COMMAND_SELECT_LIST_LAYOUT if prefix.startswith("/") else None
        return SelectList(items, self._autocomplete_max_visible, self.theme.select_list, layout)

    def _trigger_autocomplete(self, *, force: bool = False, explicit_tab: bool = False) -> None:
        self._request_autocomplete(force=force, explicit_tab=explicit_tab)

    def _request_autocomplete(self, *, force: bool, explicit_tab: bool) -> None:
        if not self._autocomplete_provider:
            return
        if force and hasattr(self._autocomplete_provider, "should_trigger_file_completion"):
            should_trigger = self._autocomplete_provider.should_trigger_file_completion(
                self._state.lines,
                self._state.cursor_line,
                self._state.cursor_col,
            )
            if not should_trigger:
                return
        self.cancel_autocomplete()
        self._autocomplete_start_token += 1
        start_token = self._autocomplete_start_token
        debounce_ms = 0
        if not explicit_tab and not force:
            line = self._state.lines[self._state.cursor_line] if self._state.lines else ""
            before = line[: self._state.cursor_col]
            if re.search(r'(?:^|[ \t])(?:@(?:"[^"]*|[^\s]*)|#[^\s]*)$', before):
                debounce_ms = ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS
        if debounce_ms > 0:

            async def _debounced() -> None:
                await asyncio.sleep(debounce_ms / 1000.0)
                await self._start_autocomplete_request(start_token, force, explicit_tab)

            self._autocomplete_debounce_task = asyncio.create_task(_debounced())
            return
        asyncio.create_task(self._start_autocomplete_request(start_token, force, explicit_tab))

    async def _start_autocomplete_request(
        self,
        start_token: int,
        force: bool,
        explicit_tab: bool,
    ) -> None:
        if start_token != self._autocomplete_start_token or not self._autocomplete_provider:
            return
        self._autocomplete_request_id += 1
        request_id = self._autocomplete_request_id
        snapshot_text = self.get_text()
        snapshot_line = self._state.cursor_line
        snapshot_col = self._state.cursor_col
        suggestions = await self._autocomplete_provider.get_suggestions(
            self._state.lines,
            self._state.cursor_line,
            self._state.cursor_col,
            {"force": force},
        )
        if not self._is_autocomplete_request_current(
            request_id, snapshot_text, snapshot_line, snapshot_col
        ):
            return
        if not suggestions or not suggestions.items:
            self.cancel_autocomplete()
            self.tui.request_render()
            return
        if force and explicit_tab and len(suggestions.items) == 1:
            self._push_undo()
            self._last_action = None
            result = self._autocomplete_provider.apply_completion(
                self._state.lines,
                self._state.cursor_line,
                self._state.cursor_col,
                suggestions.items[0],
                suggestions.prefix,
            )
            self._state.lines = result["lines"]
            self._state.cursor_line = result["cursorLine"]
            self._state.cursor_col = result["cursorCol"]
            if self.on_change:
                self.on_change(self.get_text())
            self.tui.request_render()
            return
        self._apply_autocomplete_suggestions(suggestions, "force" if force else "regular")
        self.tui.request_render()

    def _is_autocomplete_request_current(
        self,
        request_id: int,
        snapshot_text: str,
        snapshot_line: int,
        snapshot_col: int,
    ) -> bool:
        return (
            request_id == self._autocomplete_request_id
            and self.get_text() == snapshot_text
            and self._state.cursor_line == snapshot_line
            and self._state.cursor_col == snapshot_col
        )

    def _apply_autocomplete_suggestions(self, suggestions: Any, state: str) -> None:
        self._autocomplete_prefix = suggestions.prefix
        self._autocomplete_list = self._create_autocomplete_list(
            suggestions.prefix, suggestions.items
        )
        best_match_index = self._get_best_autocomplete_match_index(
            suggestions.items, suggestions.prefix
        )
        if best_match_index >= 0:
            self._autocomplete_list.set_selected_index(best_match_index)
        self._autocomplete_state = state

    def _accept_autocomplete(self) -> None:
        if not self._autocomplete_list or not self._autocomplete_provider:
            self.cancel_autocomplete()
            return
        selected = self._autocomplete_list.get_selected_item()
        if selected is None:
            self.cancel_autocomplete()
            return
        self._push_undo()
        result = self._autocomplete_provider.apply_completion(
            self._state.lines,
            self._state.cursor_line,
            self._state.cursor_col,
            selected,
            self._autocomplete_prefix,
        )
        self._state.lines = result["lines"]
        self._state.cursor_line = result["cursorLine"]
        self._state.cursor_col = result["cursorCol"]
        self.cancel_autocomplete()
        if self.on_change:
            self.on_change(self.get_text())
        self.tui.request_render()

    # =========================================================================
    # Cursor movement
    # =========================================================================

    def _move_cursor_left(self) -> None:
        self._snapped_from_cursor_col = None
        if self._state.cursor_col > 0:
            line = self._state.lines[self._state.cursor_line]
            graphemes = list(grapheme_segment(line[: self._state.cursor_col]))
            if graphemes:
                self._state.cursor_col -= len(graphemes[-1])

    def _move_cursor_right(self) -> None:
        self._snapped_from_cursor_col = None
        line = self._state.lines[self._state.cursor_line]
        if self._state.cursor_col < len(line):
            graphemes = list(grapheme_segment(line[self._state.cursor_col :]))
            if graphemes:
                self._state.cursor_col += len(graphemes[0])

    def _move_cursor_up(self) -> None:
        if self._state.cursor_line > 0:
            self._state.cursor_line -= 1
            line = self._state.lines[self._state.cursor_line]
            self._state.cursor_col = min(self._state.cursor_col, len(line))

    def _move_cursor_down(self) -> None:
        if self._state.cursor_line + 1 < len(self._state.lines):
            self._state.cursor_line += 1
            line = self._state.lines[self._state.cursor_line]
            self._state.cursor_col = min(self._state.cursor_col, len(line))

    def _move_word_left(self) -> None:
        if self._state.cursor_col > 0:
            line = self._state.lines[self._state.cursor_line]
            self._state.cursor_col = find_word_backward(line, self._state.cursor_col)

    def _move_word_right(self) -> None:
        line = self._state.lines[self._state.cursor_line]
        if self._state.cursor_col < len(line):
            self._state.cursor_col = find_word_forward(line, self._state.cursor_col)

    def _jump_to_char(self, char: str, direction: str) -> None:
        line = self._state.lines[self._state.cursor_line]
        if direction == "forward":
            idx = line.find(char, self._state.cursor_col + 1)
        else:
            idx = line.rfind(char, 0, self._state.cursor_col)
        if idx != -1:
            self._state.cursor_col = idx

    # =========================================================================
    # History navigation
    # =========================================================================

    def _is_editor_empty(self) -> bool:
        return len(self._state.lines) == 1 and self._state.lines[0] == ""

    def _is_on_first_visual_line(self) -> bool:
        return self._state.cursor_line == 0

    def _is_on_last_visual_line(self) -> bool:
        return self._state.cursor_line == len(self._state.lines) - 1

    def _copy_editor_state(self) -> EditorState:
        copied = EditorState()
        copied.lines = list(self._state.lines)
        copied.cursor_line = self._state.cursor_line
        copied.cursor_col = self._state.cursor_col
        return copied

    def _restore_editor_state(self, state: EditorState) -> None:
        self._state.lines = list(state.lines)
        self._state.cursor_line = state.cursor_line
        self._state.cursor_col = state.cursor_col
        self._scroll_offset = 0
        if self.on_change:
            self.on_change(self.get_text())

    def _history_up(self) -> None:
        if not self._history:
            return
        if self._history_index == -1:
            self._history_draft = self._copy_editor_state()
        if self._history_index + 1 < len(self._history):
            self._history_index += 1
            self._set_text_internal(self._history[self._history_index])

    def _history_down(self) -> None:
        if self._history_index <= 0:
            self._history_index = -1
            if self._history_draft is not None:
                self._restore_editor_state(self._history_draft)
                self._history_draft = None
            else:
                self._set_text_internal("")
        else:
            self._history_index -= 1
            self._set_text_internal(self._history[self._history_index])

    def _set_text_internal(self, text: str) -> None:
        lines = text.split("\n")
        self._state.lines = lines if lines else [""]
        self._state.cursor_line = len(self._state.lines) - 1
        self._state.cursor_col = len(self._state.lines[-1]) if self._state.lines else 0
        self._scroll_offset = 0
        if self.on_change:
            self.on_change(self.get_text())

    def _layout_text(self, content_width: int) -> list[_LayoutLine]:
        layout_lines: list[_LayoutLine] = []
        if not self._state.lines or (len(self._state.lines) == 1 and self._state.lines[0] == ""):
            layout_lines.append(_LayoutLine(text="", has_cursor=True, cursor_pos=0))
            return layout_lines

        for line_index, line in enumerate(self._state.lines):
            is_current_line = line_index == self._state.cursor_line
            line_width = visible_width(line)
            if line_width <= content_width:
                if is_current_line:
                    layout_lines.append(
                        _LayoutLine(text=line, has_cursor=True, cursor_pos=self._state.cursor_col)
                    )
                else:
                    layout_lines.append(_LayoutLine(text=line))
                continue

            wrapped = wrap_text_with_ansi(line, content_width) or [""]
            cursor_col = self._state.cursor_col
            offset = 0
            for chunk_index, chunk in enumerate(wrapped):
                chunk_width = visible_width(chunk)
                chunk_start = offset
                chunk_end = offset + chunk_width
                offset = chunk_end
                has_cursor = False
                cursor_pos: int | None = None
                if is_current_line:
                    if chunk_index == len(wrapped) - 1:
                        has_cursor = cursor_col >= chunk_start
                    else:
                        has_cursor = chunk_start <= cursor_col < chunk_end
                    if has_cursor:
                        cursor_pos = max(0, min(len(chunk), cursor_col - chunk_start))
                if has_cursor:
                    layout_lines.append(
                        _LayoutLine(text=chunk, has_cursor=True, cursor_pos=cursor_pos)
                    )
                else:
                    layout_lines.append(_LayoutLine(text=chunk))

        return layout_lines

    def render(self, width: int) -> list[str]:
        max_padding = max(0, width // 2)
        padding_x = min(self._padding_x, max_padding)
        content_width = max(1, width - padding_x * 2)
        layout_width = max(1, content_width - (0 if padding_x else 1))
        self._last_width = layout_width

        border_fn = self.border_color or (lambda text: text)
        horizontal = border_fn("─")
        layout_lines = self._layout_text(layout_width)

        terminal_rows = getattr(self.tui.terminal, "rows", 24)
        max_visible_lines = max(5, terminal_rows * 3 // 10)

        cursor_line_index = next(
            (index for index, line in enumerate(layout_lines) if line.has_cursor),
            0,
        )
        if cursor_line_index < self._scroll_offset:
            self._scroll_offset = cursor_line_index
        elif cursor_line_index >= self._scroll_offset + max_visible_lines:
            self._scroll_offset = cursor_line_index - max_visible_lines + 1

        max_scroll_offset = max(0, len(layout_lines) - max_visible_lines)
        self._scroll_offset = max(0, min(self._scroll_offset, max_scroll_offset))
        visible_lines = layout_lines[self._scroll_offset : self._scroll_offset + max_visible_lines]

        result: list[str] = []
        left_padding = " " * padding_x
        right_padding = left_padding

        if self._scroll_offset > 0:
            indicator = f"─── ↑ {self._scroll_offset} more "
            remaining = width - visible_width(indicator)
            if remaining >= 0:
                result.append(border_fn(indicator + "─" * remaining))
            else:
                result.append(border_fn(truncate_to_width(indicator, width)))
        else:
            result.append(horizontal * width)

        emit_cursor_marker = self._focused and not self._autocomplete_state
        for layout_line in visible_lines:
            display_text = layout_line.text
            line_visible = visible_width(display_text)
            cursor_in_padding = False

            if layout_line.has_cursor and layout_line.cursor_pos is not None:
                before = display_text[: layout_line.cursor_pos]
                after = display_text[layout_line.cursor_pos :]
                marker = CURSOR_MARKER if emit_cursor_marker else ""
                if after:
                    cursor = f"\x1b[7m{after[0]}\x1b[0m"
                    display_text = before + marker + cursor + after[1:]
                else:
                    cursor = "\x1b[7m \x1b[0m"
                    display_text = before + marker + cursor
                    line_visible += 1
                    if line_visible > content_width and padding_x > 0:
                        cursor_in_padding = True

            padding = " " * max(0, content_width - line_visible)
            line_right_padding = right_padding[1:] if cursor_in_padding else right_padding
            result.append(f"{left_padding}{display_text}{padding}{line_right_padding}")

        lines_below = len(layout_lines) - (self._scroll_offset + len(visible_lines))
        if lines_below > 0:
            indicator = f"─── ↓ {lines_below} more "
            remaining = width - visible_width(indicator)
            result.append(border_fn(indicator + "─" * max(0, remaining)))
        else:
            result.append(horizontal * width)

        if self._autocomplete_state and self._autocomplete_list is not None:
            for line in self._autocomplete_list.render(content_width):
                line_width = visible_width(line)
                line_padding = " " * max(0, content_width - line_width)
                result.append(f"{left_padding}{line}{line_padding}{right_padding}")

        return result
