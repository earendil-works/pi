"""Input component - single-line text input with horizontal scrolling"""

from pi_mono.tui.keys import decode_kitty_printable
from pi_mono.tui.kill_ring import KillRing
from pi_mono.tui.editor_component import Component
from pi_mono.tui.tui import CURSOR_MARKER
from pi_mono.tui.undo_stack import UndoStack
from pi_mono.tui.utils import (
    grapheme_segment,
    is_whitespace_char,
    slice_by_column,
    visible_width,
)
from pi_mono.tui.word_navigation import find_word_backward, find_word_forward
from pi_mono.tui.keybindings import get_keybindings

from typing import Callable, Optional


def _segment_graphemes(text: str) -> list[str]:
    """Segment text into graphemes"""
    return list(grapheme_segment(text))


class InputState:
    """Input state for undo stack"""

    def __init__(self, value: str, cursor: int) -> None:
        self.value = value
        self.cursor = cursor


class Input(Component):
    """Input component - single-line text input with horizontal scrolling"""

    def __init__(self) -> None:
        self._value: str = ""
        self._cursor: int = 0
        self.on_submit: Optional[Callable[[str], None]] = None
        self.on_escape: Optional[Callable[[], None]] = None
        self.focused: bool = False

        # Bracketed paste mode buffering
        self._paste_buffer: str = ""
        self._is_in_paste: bool = False

        # Kill ring for Emacs-style kill/yank operations
        self._kill_ring = KillRing()
        self._last_action: Optional[str] = None

        # Undo support
        self._undo_stack = UndoStack[InputState]()

    @property
    def value(self) -> str:
        return self._value

    @property
    def cursor(self) -> int:
        return self._cursor

    def get_value(self) -> str:
        return self._value

    def set_value(self, value: str) -> None:
        self._value = value
        self._cursor = min(self._cursor, len(value))

    def _push_undo(self) -> None:
        self._undo_stack.push(InputState(self._value, self._cursor))

    def _undo(self) -> None:
        snapshot = self._undo_stack.pop()
        if not snapshot:
            return
        self._value = snapshot.value
        self._cursor = snapshot.cursor
        self._last_action = None

    def handle_input(self, data: str) -> None:
        # Handle bracketed paste mode
        # Start of paste: \x1b[200~
        # End of paste: \x1b[201~

        # Check if we're starting a bracketed paste
        if "\x1b[200~" in data:
            self._is_in_paste = True
            self._paste_buffer = ""
            data = data.replace("\x1b[200~", "")

        # If we're in a paste, buffer the data
        if self._is_in_paste:
            # Check if this chunk contains the end marker
            self._paste_buffer += data

            end_index = self._paste_buffer.index("\x1b[201~")
            if end_index != -1:
                # Extract the pasted content
                paste_content = self._paste_buffer[:end_index]

                # Process the complete paste
                self._handle_paste(paste_content)

                # Reset paste state
                self._is_in_paste = False

                # Handle any remaining input after the paste marker
                remaining = self._paste_buffer[end_index + 6 :]  # 6 = length of \x1b[201~
                self._paste_buffer = ""
                if remaining:
                    self.handle_input(remaining)
            return

        kb = get_keybindings()

        # Escape/Cancel
        if kb.matches(data, "tui.select.cancel"):
            if self.on_escape:
                self.on_escape()
            return

        # Undo
        if kb.matches(data, "tui.editor.undo"):
            self._undo()
            return

        # Submit
        if kb.matches(data, "tui.input.submit") or data == "\n":
            if self.on_submit:
                self.on_submit(self._value)
            return

        # Deletion
        if kb.matches(data, "tui.editor.deleteCharBackward"):
            self._handle_backspace()
            return

        if kb.matches(data, "tui.editor.deleteCharForward"):
            self._handle_forward_delete()
            return

        if kb.matches(data, "tui.editor.deleteWordBackward"):
            self._delete_word_backwards()
            return

        if kb.matches(data, "tui.editor.deleteWordForward"):
            self._delete_word_forward()
            return

        if kb.matches(data, "tui.editor.deleteToLineStart"):
            self._delete_to_line_start()
            return

        if kb.matches(data, "tui.editor.deleteToLineEnd"):
            self._delete_to_line_end()
            return

        # Kill ring actions
        if kb.matches(data, "tui.editor.yank"):
            self._yank()
            return
        if kb.matches(data, "tui.editor.yankPop"):
            self._yank_pop()
            return

        # Cursor movement
        if kb.matches(data, "tui.editor.cursorLeft"):
            self._last_action = None
            if self._cursor > 0:
                before_cursor = self._value[: self._cursor]
                graphemes = _segment_graphemes(before_cursor)
                last_grapheme = graphemes[-1] if graphemes else None
                self._cursor -= len(last_grapheme) if last_grapheme else 1
            return

        if kb.matches(data, "tui.editor.cursorRight"):
            self._last_action = None
            if self._cursor < len(self._value):
                after_cursor = self._value[self._cursor :]
                graphemes = _segment_graphemes(after_cursor)
                first_grapheme = graphemes[0] if graphemes else None
                self._cursor += len(first_grapheme) if first_grapheme else 1
            return

        if kb.matches(data, "tui.editor.cursorLineStart"):
            self._last_action = None
            self._cursor = 0
            return

        if kb.matches(data, "tui.editor.cursorLineEnd"):
            self._last_action = None
            self._cursor = len(self._value)
            return

        if kb.matches(data, "tui.editor.cursorWordLeft"):
            self._move_word_backwards()
            return

        if kb.matches(data, "tui.editor.cursorWordRight"):
            self._move_word_forwards()
            return

        # Kitty CSI-u printable character
        kitty_printable = decode_kitty_printable(data)
        if kitty_printable is not None:
            self._insert_character(kitty_printable)
            return

        # Regular character input - accept printable characters including Unicode,
        # but reject control characters (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
        has_control_chars = any(
            ord(ch) < 32 or ord(ch) == 0x7F or (0x80 <= ord(ch) <= 0x9F) for ch in data
        )
        if not has_control_chars:
            self._insert_character(data)

    def _insert_character(self, char: str) -> None:
        # Undo coalescing: consecutive word chars coalesce into one undo unit
        if is_whitespace_char(char) or self._last_action != "type-word":
            self._push_undo()
        self._last_action = "type-word"

        self._value = self._value[: self._cursor] + char + self._value[self._cursor :]
        self._cursor += len(char)

    def _handle_backspace(self) -> None:
        self._last_action = None
        if self._cursor > 0:
            self._push_undo()
            before_cursor = self._value[: self._cursor]
            graphemes = _segment_graphemes(before_cursor)
            last_grapheme = graphemes[-1] if graphemes else None
            grapheme_length = len(last_grapheme) if last_grapheme else 1
            self._value = (
                self._value[: self._cursor - grapheme_length] + self._value[self._cursor :]
            )
            self._cursor -= grapheme_length

    def _handle_forward_delete(self) -> None:
        self._last_action = None
        if self._cursor < len(self._value):
            self._push_undo()
            after_cursor = self._value[self._cursor :]
            graphemes = _segment_graphemes(after_cursor)
            first_grapheme = graphemes[0] if graphemes else None
            grapheme_length = len(first_grapheme) if first_grapheme else 1
            self._value = (
                self._value[: self._cursor] + self._value[self._cursor + grapheme_length :]
            )

    def _delete_to_line_start(self) -> None:
        if self._cursor == 0:
            return
        self._push_undo()
        deleted_text = self._value[: self._cursor]
        self._kill_ring.push(
            deleted_text, {"prepend": True, "accumulate": self._last_action == "kill"}
        )
        self._last_action = "kill"
        self._value = self._value[self._cursor :]
        self._cursor = 0

    def _delete_to_line_end(self) -> None:
        if self._cursor >= len(self._value):
            return
        self._push_undo()
        deleted_text = self._value[self._cursor :]
        self._kill_ring.push(
            deleted_text, {"prepend": False, "accumulate": self._last_action == "kill"}
        )
        self._last_action = "kill"
        self._value = self._value[: self._cursor]

    def _delete_word_backwards(self) -> None:
        if self._cursor == 0:
            return

        # Save lastAction before cursor movement (moveWordBackwards resets it)
        was_kill = self._last_action == "kill"

        self._push_undo()

        old_cursor = self._cursor
        self._move_word_backwards()
        delete_from = self._cursor
        self._cursor = old_cursor

        deleted_text = self._value[delete_from : self._cursor]
        self._kill_ring.push(deleted_text, {"prepend": True, "accumulate": was_kill})
        self._last_action = "kill"

        self._value = self._value[:delete_from] + self._value[self._cursor :]
        self._cursor = delete_from

    def _delete_word_forward(self) -> None:
        if self._cursor >= len(self._value):
            return

        # Save lastAction before cursor movement (moveWordForwards resets it)
        was_kill = self._last_action == "kill"

        self._push_undo()

        old_cursor = self._cursor
        self._move_word_forwards()
        delete_to = self._cursor
        self._cursor = old_cursor

        deleted_text = self._value[self._cursor : delete_to]
        self._kill_ring.push(deleted_text, {"prepend": False, "accumulate": was_kill})
        self._last_action = "kill"

        self._value = self._value[: self._cursor] + self._value[delete_to:]

    def _yank(self) -> None:
        text = self._kill_ring.peek()
        if not text:
            return

        self._push_undo()

        self._value = self._value[: self._cursor] + text + self._value[self._cursor :]
        self._cursor += len(text)
        self._last_action = "yank"

    def _yank_pop(self) -> None:
        if self._last_action != "yank" or len(self._kill_ring) <= 1:
            return

        self._push_undo()

        # Delete the previously yanked text (still at end of ring before rotation)
        prev_text = self._kill_ring.peek() or ""
        self._value = self._value[: self._cursor - len(prev_text)] + self._value[self._cursor :]
        self._cursor -= len(prev_text)

        # Rotate and insert new entry
        self._kill_ring.rotate()
        text = self._kill_ring.peek() or ""
        self._value = self._value[: self._cursor] + text + self._value[self._cursor :]
        self._cursor += len(text)
        self._last_action = "yank"

    def _move_word_backwards(self) -> None:
        if self._cursor == 0:
            return
        self._last_action = None
        self._cursor = find_word_backward(self._value, self._cursor)

    def _move_word_forwards(self) -> None:
        if self._cursor >= len(self._value):
            return
        self._last_action = None
        self._cursor = find_word_forward(self._value, self._cursor)

    def _handle_paste(self, pasted_text: str) -> None:
        self._last_action = None
        self._push_undo()

        # Clean the pasted text - remove newlines and carriage returns
        clean_text = (
            pasted_text.replace("\r\n", "")
            .replace("\r", "")
            .replace("\n", "")
            .replace("\t", "    ")
        )

        # Insert at cursor position
        self._value = self._value[: self._cursor] + clean_text + self._value[self._cursor :]
        self._cursor += len(clean_text)

    def invalidate(self) -> None:
        # No cached state to invalidate currently
        pass

    def render(self, width: int) -> list[str]:
        # Calculate visible window
        prompt = "> "
        available_width = width - len(prompt)

        if available_width <= 0:
            return [prompt]

        visible_text = ""
        cursor_display = self._cursor
        total_width = visible_width(self._value)

        if total_width < available_width:
            # Everything fits (leave room for cursor at end)
            visible_text = self._value
        else:
            # Need horizontal scrolling
            # Reserve one column for cursor if it's at the end
            scroll_width = (
                available_width - 1 if self._cursor == len(self._value) else available_width
            )
            cursor_col = visible_width(self._value[: self._cursor])

            if scroll_width > 0:
                half_width = scroll_width // 2
                start_col = 0

                if cursor_col < half_width:
                    # Cursor near start
                    start_col = 0
                elif cursor_col > total_width - half_width:
                    # Cursor near end
                    start_col = max(0, total_width - scroll_width)
                else:
                    # Cursor in middle
                    start_col = max(0, cursor_col - half_width)

                visible_text = slice_by_column(self._value, start_col, scroll_width, True)
                before_cursor = slice_by_column(
                    self._value, start_col, max(0, cursor_col - start_col), True
                )
                cursor_display = len(before_cursor)
            else:
                visible_text = ""
                cursor_display = 0

        # Build line with fake cursor
        # Insert cursor character at cursor position
        graphemes = _segment_graphemes(visible_text[cursor_display:])
        cursor_grapheme = graphemes[0] if graphemes else None

        # Handle case where cursor is beyond visible_text
        if cursor_display >= len(visible_text):
            before_cursor = visible_text
            at_cursor = " "  # Space if at end
            after_cursor = ""
        else:
            before_cursor = visible_text[:cursor_display]
            at_cursor = cursor_grapheme if cursor_grapheme else " "
            after_cursor = visible_text[cursor_display + len(at_cursor) :]

        # Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
        marker = CURSOR_MARKER if self.focused else ""

        # Use inverse video to show cursor
        cursor_char = f"\x1b[7m{at_cursor}\x1b[27m"  # ESC[7m = reverse video, ESC[27m = normal
        text_with_cursor = before_cursor + marker + cursor_char + after_cursor

        # Calculate visual width
        visual_length = visible_width(text_with_cursor)
        padding = " " * max(0, available_width - visual_length)
        line = prompt + text_with_cursor + padding

        return [line]
