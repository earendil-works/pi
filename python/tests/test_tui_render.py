import os
import re
import asyncio
import pytest
import contextlib
from typing import Callable, Dict, List, Optional

from pi_mono.tui.tui import Component, TUI
from pi_mono.tui.terminal_image import (
    encode_kitty,
    delete_kitty_image,
)


class StubComponent(Component):
    def __init__(self) -> None:
        self.lines: List[str] = []

    def render(self, width: int) -> List[str]:
        return self.lines

    def invalidate(self) -> None:
        pass

    def handle_input(self, data: str) -> None:
        pass

    @property
    def wants_key_release(self) -> bool:
        return False


class LoggingVirtualTerminal:
    def __init__(self, columns: int = 80, rows: int = 24) -> None:
        self._columns = columns
        self._rows = rows
        self.writes: List[str] = []
        self._cursor_visible = True
        self.input_handler: Optional[Callable[[str], None]] = None
        self.resize_handler: Optional[Callable[[], None]] = None
        self._stopped = False

        # Entire scroll buffer as a list of rows, each row is a list of self._columns cells: (char, is_italic)
        self.scroll_buffer = [[(" ", False) for _ in range(self._columns)]]
        self.cursor_x = 0
        self.cursor_y = 0
        self.viewport_top = 0
        self.italic_active = False

    @property
    def columns(self) -> int:
        return self._columns

    @property
    def rows(self) -> int:
        return self._rows

    @property
    def kittyProtocolActive(self) -> bool:
        return True

    def start(self, on_input: Callable[[str], None], on_resize: Callable[[], None]) -> None:
        self.input_handler = on_input
        self.resize_handler = on_resize

    def stop(self) -> None:
        self._stopped = True

    def write(self, data: str) -> None:
        self.writes.append(data)
        self._interpret(data)

    def hideCursor(self) -> None:
        self._cursor_visible = False

    def showCursor(self) -> None:
        self._cursor_visible = True

    def get_writes(self) -> str:
        return "".join(self.writes)

    def clear_writes(self) -> None:
        self.writes = []

    def resize(self, columns: int, rows: int) -> None:
        old_viewport_top = self.viewport_top
        old_cursor_y = self.cursor_y

        self._columns = columns
        self._rows = rows

        # Resize columns in all existing rows
        for i in range(len(self.scroll_buffer)):
            if len(self.scroll_buffer[i]) < self._columns:
                self.scroll_buffer[i] += [
                    (" ", False) for _ in range(self._columns - len(self.scroll_buffer[i]))
                ]
            elif len(self.scroll_buffer[i]) > self._columns:
                self.scroll_buffer[i] = self.scroll_buffer[i][: self._columns]

        # Calculate new viewport top keeping bottom aligned
        new_viewport_top = max(0, len(self.scroll_buffer) - self._rows)
        new_cursor_y = (old_viewport_top + old_cursor_y) - new_viewport_top
        self.viewport_top = new_viewport_top
        self.cursor_y = max(0, min(self._rows - 1, new_cursor_y))

        if self.resize_handler:
            self.resize_handler()

    def get_viewport(self) -> List[str]:
        # Get slice from scroll buffer
        viewport_lines = []
        for i in range(self._rows):
            idx = self.viewport_top + i
            if idx < len(self.scroll_buffer):
                row_str = "".join(cell[0] for cell in self.scroll_buffer[idx])
                viewport_lines.append(row_str.rstrip())
            else:
                viewport_lines.append("")
        return viewport_lines

    def get_cell_italic(self, row: int, col: int) -> bool:
        idx = self.viewport_top + row
        if 0 <= idx < len(self.scroll_buffer) and 0 <= col < len(self.scroll_buffer[idx]):
            return self.scroll_buffer[idx][col][1]
        return False

    async def wait_for_render(self) -> None:
        # Give event loop time to run call_soon/call_later callbacks
        await asyncio.sleep(0.02)

    def _interpret(self, data: str) -> None:
        # CSI, OSC, APC/Kitty, simple ESC, newlines, and plain text
        ansi_regex = re.compile(
            r"\x1b\[[?0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*(?:\x1b\\|\x07)|\x1b[a-zA-Z]|\r\n|\r|\n|[^\x1b\r\n]+"
        )
        tokens = ansi_regex.findall(data)

        for token in tokens:
            if token in ("\r\n", "\n"):
                if self.cursor_y >= self._rows - 1:
                    # Scroll up viewport: append new row to scroll_buffer
                    self.scroll_buffer.append([(" ", False) for _ in range(self._columns)])
                    self.viewport_top += 1
                    self.cursor_y = self._rows - 1
                else:
                    self.cursor_y += 1
                self.cursor_x = 0
            elif token == "\r":
                self.cursor_x = 0
            elif token.startswith("\x1b["):
                code = token[-1]
                params_str = token[2:-1]
                if params_str.startswith("?"):
                    params_str = params_str[1:]
                params = [int(p) for p in params_str.split(";") if p.isdigit()]

                if code == "A":  # Move up
                    count = params[0] if params else 1
                    self.cursor_y = max(0, self.cursor_y - count)
                elif code == "B":  # Move down
                    count = params[0] if params else 1
                    self.cursor_y = min(self._rows - 1, self.cursor_y + count)
                elif code == "G":  # Move cursor to col (1-indexed)
                    col = params[0] if params else 1
                    self.cursor_x = max(0, min(self._columns - 1, col - 1))
                elif code == "H":  # Move cursor to home or (row, col)
                    row = params[0] if len(params) > 0 else 1
                    col = params[1] if len(params) > 1 else 1
                    self.cursor_y = max(0, min(self._rows - 1, row - 1))
                    self.cursor_x = max(0, min(self._columns - 1, col - 1))
                elif code == "J":  # Clear screen
                    val = params[0] if params else 0
                    if val == 2:
                        self.scroll_buffer = [
                            [(" ", False) for _ in range(self._columns)] for _ in range(self._rows)
                        ]
                        self.viewport_top = 0
                        self.cursor_y = 0
                        self.cursor_x = 0
                elif code == "K":  # Clear line
                    val = params[0] if params else 0
                    abs_y = self.viewport_top + self.cursor_y
                    while len(self.scroll_buffer) <= abs_y:
                        self.scroll_buffer.append([(" ", False) for _ in range(self._columns)])
                    if val == 0:
                        for x in range(self.cursor_x, self._columns):
                            self.scroll_buffer[abs_y][x] = (" ", False)
                    elif val == 2:
                        self.scroll_buffer[abs_y] = [(" ", False) for _ in range(self._columns)]
                elif code == "m":  # Style
                    if 3 in params:
                        self.italic_active = True
                    if 23 in params or 0 in params:
                        self.italic_active = False
            elif token.startswith("\x1b"):
                pass
            else:
                # Printable text token
                for char in token:
                    abs_y = self.viewport_top + self.cursor_y
                    while len(self.scroll_buffer) <= abs_y:
                        self.scroll_buffer.append([(" ", False) for _ in range(self._columns)])
                    if self.cursor_x >= self._columns:
                        break
                    self.scroll_buffer[abs_y][self.cursor_x] = (char, self.italic_active)
                    self.cursor_x += 1


@contextlib.contextmanager
def with_env(overrides: Dict[str, Optional[str]]):
    saved = {}
    for k, v in overrides.items():
        saved[k] = os.environ.get(k)
        if v is None:
            if k in os.environ:
                del os.environ[k]
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                if k in os.environ:
                    del os.environ[k]
            else:
                os.environ[k] = v


@pytest.mark.anyio
async def test_kitty_deletes_changed_image_ids():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    old_image = encode_kitty("AAAA", {"columns": 2, "rows": 2, "imageId": 42, "moveCursor": False})
    component.lines = ["top", old_image]
    tui.start()
    await terminal.wait_for_render()
    terminal.clear_writes()

    new_image = encode_kitty("BBBB", {"columns": 2, "rows": 1, "imageId": 42, "moveCursor": False})
    component.lines = [new_image, ""]
    tui.request_render()
    await terminal.wait_for_render()

    writes = terminal.get_writes()
    delete_seq = delete_kitty_image(42)
    assert delete_seq in writes, "changed old image should be deleted"
    assert new_image in writes, "new image should be drawn"
    assert writes.index(delete_seq) < writes.index(
        new_image
    ), "old image must be deleted before new placement is drawn"
    tui.stop()


@pytest.mark.anyio
async def test_kitty_redraws_image_lines_on_reserved_row_change():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    image = encode_kitty("AAAA", {"columns": 2, "rows": 2, "imageId": 88, "moveCursor": False})
    component.lines = ["", image]
    tui.start()
    await terminal.wait_for_render()
    terminal.clear_writes()

    component.lines = ["covered", image]
    tui.request_render()
    await terminal.wait_for_render()

    writes = terminal.get_writes()
    delete_seq = delete_kitty_image(88)
    assert delete_seq in writes, "image should be deleted when a reserved row changes"
    assert image in writes, "unchanged image line should be redrawn after deleting the placement"
    assert writes.index(delete_seq) < writes.index(
        image
    ), "old placement must be deleted before image line is redrawn"
    assert "\x1b[2J" not in writes, "reserved row changes should not force a full redraw"
    tui.stop()


@pytest.mark.anyio
async def test_kitty_deletes_previous_image_ids_during_full_redraw():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = [
        encode_kitty("AAAA", {"columns": 2, "rows": 2, "imageId": 77, "moveCursor": False})
    ]
    tui.start()
    await terminal.wait_for_render()
    terminal.clear_writes()

    component.lines = ["plain text"]
    tui.request_render(force=True)
    await terminal.wait_for_render()

    writes = terminal.get_writes()
    delete_seq = delete_kitty_image(77)
    assert delete_seq in writes, "previous image should be deleted during full redraw"
    assert "\x1b[2J" in writes, "full redraw should clear the screen"
    assert writes.index(delete_seq) < writes.index(
        "\x1b[2J"
    ), "old image should be deleted before screen is cleared"
    tui.stop()


@pytest.mark.anyio
async def test_resize_triggers_full_rerender_on_height_change():
    with with_env({"TERMUX_VERSION": None}):
        terminal = LoggingVirtualTerminal(40, 10)
        tui = TUI(terminal)
        component = StubComponent()
        tui.add_child(component)

        component.lines = ["Line 0", "Line 1", "Line 2"]
        tui.start()
        await terminal.wait_for_render()

        initial_redraws = tui.full_redraws

        terminal.resize(40, 15)
        await terminal.wait_for_render()

        assert tui.full_redraws > initial_redraws, "Height change should trigger full redraw"
        viewport = terminal.get_viewport()
        assert any("Line 0" in line for line in viewport), "Content preserved after height change"
        tui.stop()


@pytest.mark.anyio
async def test_resize_skips_full_rerender_on_height_change_in_termux():
    with with_env({"TERMUX_VERSION": "1"}):
        terminal = LoggingVirtualTerminal(40, 10)
        tui = TUI(terminal)
        component = StubComponent()
        tui.add_child(component)

        component.lines = [f"Line {i}" for i in range(20)]
        tui.start()
        await terminal.wait_for_render()
        terminal.clear_writes()

        initial_redraws = tui.full_redraws
        for height in [15, 8, 14, 11]:
            terminal.resize(40, height)
            await terminal.wait_for_render()

        assert (
            tui.full_redraws == initial_redraws
        ), "Height change in Termux should not trigger full redraw"
        writes = terminal.get_writes()
        assert "\x1b[2J" not in writes, "Height change should not clear screen"
        assert "\x1b[3J" not in writes, "Height change should not clear scrollback"

        viewport = terminal.get_viewport()
        assert any(
            "Line 19" in line for line in viewport
        ), "Latest content remains visible after resize"
        tui.stop()


@pytest.mark.anyio
async def test_resize_triggers_full_rerender_on_width_change():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2"]
    tui.start()
    await terminal.wait_for_render()

    initial_redraws = tui.full_redraws

    terminal.resize(60, 10)
    await terminal.wait_for_render()

    assert tui.full_redraws > initial_redraws, "Width change should trigger full redraw"
    tui.stop()


@pytest.mark.anyio
async def test_shrink_clears_empty_rows():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    tui.set_clear_on_shrink(True)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]
    tui.start()
    await terminal.wait_for_render()

    initial_redraws = tui.full_redraws

    component.lines = ["Line 0", "Line 1"]
    tui.request_render()
    await terminal.wait_for_render()

    assert tui.full_redraws > initial_redraws, "Content shrinkage should trigger full redraw"
    viewport = terminal.get_viewport()
    assert "Line 0" in viewport[0]
    assert "Line 1" in viewport[1]
    assert viewport[2].strip() == ""
    assert viewport[3].strip() == ""
    tui.stop()


@pytest.mark.anyio
async def test_shrink_handles_shrink_to_single_line():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    tui.set_clear_on_shrink(True)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"]
    tui.start()
    await terminal.wait_for_render()

    component.lines = ["Only line"]
    tui.request_render()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert "Only line" in viewport[0]
    assert viewport[1].strip() == ""
    tui.stop()


@pytest.mark.anyio
async def test_shrink_handles_shrink_to_empty():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    tui.set_clear_on_shrink(True)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2"]
    tui.start()
    await terminal.wait_for_render()

    component.lines = []
    tui.request_render()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert viewport[0].strip() == ""
    assert viewport[1].strip() == ""
    tui.stop()


@pytest.mark.anyio
async def test_diff_tracks_cursor_when_content_shrinks_with_unchanged_lines():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"]
    tui.start()
    await terminal.wait_for_render()

    component.lines = ["Line 0", "Line 1", "Line 2"]
    tui.request_render()
    await terminal.wait_for_render()

    component.lines = ["Line 0", "CHANGED", "Line 2"]
    tui.request_render()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert "CHANGED" in viewport[1]
    tui.stop()


@pytest.mark.anyio
async def test_diff_renders_middle_line_changes():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Header", "Working...", "Footer"]
    tui.start()
    await terminal.wait_for_render()

    for frame in ["|", "/", "-", "\\"]:
        component.lines = ["Header", f"Working {frame}", "Footer"]
        tui.request_render()
        await terminal.wait_for_render()

        viewport = terminal.get_viewport()
        assert "Header" in viewport[0]
        assert f"Working {frame}" in viewport[1]
        assert "Footer" in viewport[2]

    tui.stop()


@pytest.mark.anyio
async def test_diff_resets_styles_after_each_line():
    terminal = LoggingVirtualTerminal(20, 6)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["\x1b[3mItalic", "Plain"]
    tui.start()
    await terminal.wait_for_render()

    assert terminal.get_cell_italic(1, 0) is False
    tui.stop()


@pytest.mark.anyio
async def test_diff_renders_first_line_changes():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"]
    tui.start()
    await terminal.wait_for_render()

    component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"]
    tui.request_render()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert "CHANGED" in viewport[0]
    assert "Line 1" in viewport[1]
    assert "Line 2" in viewport[2]
    assert "Line 3" in viewport[3]
    tui.stop()


@pytest.mark.anyio
async def test_diff_renders_last_line_changes():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"]
    tui.start()
    await terminal.wait_for_render()

    component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"]
    tui.request_render()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert "Line 0" in viewport[0]
    assert "Line 1" in viewport[1]
    assert "Line 2" in viewport[2]
    assert "CHANGED" in viewport[3]
    tui.stop()


@pytest.mark.anyio
async def test_diff_renders_multiple_non_adjacent_line_changes():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"]
    tui.start()
    await terminal.wait_for_render()

    component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"]
    tui.request_render()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert "Line 0" in viewport[0]
    assert "CHANGED 1" in viewport[1]
    assert "Line 2" in viewport[2]
    assert "CHANGED 3" in viewport[3]
    assert "Line 4" in viewport[4]
    tui.stop()


@pytest.mark.anyio
async def test_diff_handles_transition_to_empty_and_back():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = ["Line 0", "Line 1", "Line 2"]
    tui.start()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert "Line 0" in viewport[0]

    component.lines = []
    tui.request_render()
    await terminal.wait_for_render()

    component.lines = ["New Line 0", "New Line 1"]
    tui.request_render()
    await terminal.wait_for_render()

    viewport = terminal.get_viewport()
    assert "New Line 0" in viewport[0]
    assert "New Line 1" in viewport[1]
    tui.stop()


@pytest.mark.anyio
async def test_diff_full_rerenders_on_viewport_move_upward():
    terminal = LoggingVirtualTerminal(20, 5)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = [f"Line {i}" for i in range(12)]
    tui.start()
    await terminal.wait_for_render()

    initial_redraws = tui.full_redraws

    component.lines = [f"Line {i}" for i in range(7)]
    tui.request_render()
    await terminal.wait_for_render()

    assert tui.full_redraws > initial_redraws, "Shrink should trigger a full redraw"
    viewport = terminal.get_viewport()
    assert viewport == ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]
    tui.stop()


@pytest.mark.anyio
async def test_diff_appends_after_shrink_without_full_redraw():
    terminal = LoggingVirtualTerminal(20, 5)
    tui = TUI(terminal)
    component = StubComponent()
    tui.add_child(component)

    component.lines = [f"Line {i}" for i in range(8)]
    tui.start()
    await terminal.wait_for_render()

    initial_redraws = tui.full_redraws

    component.lines = ["Line 0", "Line 1"]
    tui.request_render()
    await terminal.wait_for_render()

    assert tui.full_redraws > initial_redraws, "Shrink should reset viewport with full redraw"
    redraws_after_shrink = tui.full_redraws

    component.lines = ["Line 0", "Line 1", "Line 2"]
    tui.request_render()
    await terminal.wait_for_render()

    assert tui.full_redraws == redraws_after_shrink, "Append should stay on differential path"
    viewport = terminal.get_viewport()
    assert viewport == ["Line 0", "Line 1", "Line 2", "", ""]
    tui.stop()


@pytest.mark.anyio
async def test_diff_clears_stale_content_inflated_by_transient_component():
    terminal = LoggingVirtualTerminal(40, 10)
    tui = TUI(terminal)
    chat = StubComponent()
    editor = StubComponent()
    tui.add_child(chat)
    tui.add_child(editor)

    long_chat = [f"Chat {i}" for i in range(15)]
    short_chat = [f"Chat {i}" for i in range(12)]
    editor_lines = ["Editor 0", "Editor 1", "Editor 2"]
    selector_lines = [f"Selector {i}" for i in range(8)]

    chat.lines = long_chat
    editor.lines = editor_lines
    tui.start()
    await terminal.wait_for_render()

    editor.lines = selector_lines
    tui.request_render()
    await terminal.wait_for_render()

    editor.lines = editor_lines
    tui.request_render()
    await terminal.wait_for_render()

    redraws_before_switch = tui.full_redraws
    chat.lines = short_chat
    tui.request_render()
    await terminal.wait_for_render()

    assert tui.full_redraws > redraws_before_switch, "Branch switch should trigger full redraw"

    viewport = terminal.get_viewport()
    for row_str in viewport:
        assert "Chat 12" not in row_str
        assert "Chat 13" not in row_str
        assert "Chat 14" not in row_str

    assert viewport == [
        "Chat 5",
        "Chat 6",
        "Chat 7",
        "Chat 8",
        "Chat 9",
        "Chat 10",
        "Chat 11",
        "Editor 0",
        "Editor 1",
        "Editor 2",
    ]
    tui.stop()
