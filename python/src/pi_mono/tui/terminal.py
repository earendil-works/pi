import os
import re
import sys
import time
import signal
import asyncio
import threading
import ctypes
from typing import Callable, Literal, Any, Union

from pi_mono.tui.keys import set_kitty_protocol_active
from pi_mono.tui.native_modifiers import is_native_modifier_pressed
from pi_mono.tui.stdin_buffer import StdinBuffer

# Platform checks
IS_WINDOWS = sys.platform == "win32"
if not IS_WINDOWS:
    import tty
    import termios

TERMINAL_PROGRESS_KEEPALIVE_MS = 1000
TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07"
TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07"
APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u"
DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7
KITTY_KEYBOARD_PROTOCOL_FALLBACK_TIMEOUT_MS = 150
KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150
KITTY_KEYBOARD_PROTOCOL_QUERY = f"\x1b[>{DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u\x1b[c"


def parse_keyboard_protocol_negotiation_sequence(sequence: str) -> dict[str, Any] | None:
    kitty_flags = re.match(r"^\x1b\[\?(\d+)u$", sequence)
    if kitty_flags:
        return {"type": "kitty-flags", "flags": int(kitty_flags.group(1))}
    if re.match(r"^\x1b\[\?[\d;]*c$", sequence):
        return {"type": "device-attributes"}
    return None


def is_keyboard_protocol_negotiation_sequence_prefix(
    sequence: str, allow_bare_escape_prefix: bool
) -> bool:
    return (
        (allow_bare_escape_prefix and sequence == "\x1b")
        or sequence == "\x1b["
        or bool(re.match(r"^\x1b\[\?[\d;]*$", sequence))
    )


def is_apple_terminal_session() -> bool:
    return sys.platform == "darwin" and os.environ.get("TERM_PROGRAM") == "Apple_Terminal"


def normalize_apple_terminal_input(
    data: str, is_apple_terminal: bool, is_shift_pressed: bool
) -> str:
    if is_apple_terminal and data == "\r" and is_shift_pressed:
        return APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE
    return data


def _get_write_log_path() -> str:
    env = os.environ.get("PI_TUI_WRITE_LOG", "")
    if not env:
        return ""
    try:
        if os.path.isdir(env):
            now = time.localtime()
            ts = time.strftime("%Y-%m-%d_%H-%M-%S", now)
            return os.path.join(env, f"tui-{ts}-{os.getpid()}.log")
    except Exception:
        pass
    return env


class ProcessTerminal:
    def __init__(self) -> None:
        self.was_raw: Any = None
        self.input_handler: Callable[[str], None] | None = None
        self.resize_handler: Callable[[], None] | None = None
        self._kitty_protocol_active = False
        self._modify_other_keys_active = False
        self.keyboard_protocol_pushed = False
        self.keyboard_protocol_negotiation_pending = False
        self.keyboard_protocol_late_response_pending = False
        self.keyboard_protocol_negotiation_buffer = ""
        self.keyboard_protocol_fallback_timer: asyncio.TimerHandle | None = None
        self.keyboard_protocol_buffer_flush_timer: asyncio.TimerHandle | None = None
        self.stdin_buffer: StdinBuffer | None = None
        self.progress_task: asyncio.Task[None] | None = None
        self._fd = sys.stdin.fileno()
        self.write_log_path = _get_write_log_path()

        # Windows background reader properties
        self._stop_read_event = threading.Event()
        self._read_thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def kittyProtocolActive(self) -> bool:
        return self._kitty_protocol_active

    def start(self, on_input: Callable[[str], None], on_resize: Callable[[], None]) -> None:
        self.input_handler = on_input
        self.resize_handler = on_resize

        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = asyncio.get_event_loop()

        # Save previous raw mode and enable raw mode
        if not IS_WINDOWS:
            try:
                self.was_raw = termios.tcgetattr(self._fd)
                tty.setraw(self._fd)
            except Exception:
                self.was_raw = None
        else:
            # Save Windows console mode
            try:
                kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
                hStdin = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE = -10
                mode = ctypes.c_ulong()
                if kernel32.GetConsoleMode(hStdin, ctypes.byref(mode)):
                    self.was_raw = mode.value
                    # Set Windows console to raw mode (disable echo and line buffering)
                    # and allow VT-100 inputs
                    ENABLE_ECHO_INPUT = 0x0004
                    ENABLE_LINE_INPUT = 0x0002
                    ENABLE_PROCESSED_INPUT = 0x0001
                    ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
                    raw_mode = mode.value & ~(
                        ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT
                    )
                    kernel32.SetConsoleMode(hStdin, raw_mode | ENABLE_VIRTUAL_TERMINAL_INPUT)
            except Exception:
                self.was_raw = None

        # Enable bracketed paste mode
        self.write("\x1b[?2004h")

        # Set up resize signal/handler
        if not IS_WINDOWS:
            try:
                signal.signal(signal.SIGWINCH, self._on_sigwinch)
            except ValueError:
                pass
            # Trigger initial resize calculation
            os.kill(os.getpid(), signal.SIGWINCH)

        self.enable_windows_vt_input()
        self.query_and_enable_kitty_protocol()

        # Start listening for stdin inputs asynchronously
        if not IS_WINDOWS:
            self._loop.add_reader(self._fd, self._on_readable)
        else:
            self._stop_read_event.clear()
            self._read_thread = threading.Thread(target=self._windows_read_loop, daemon=True)
            self._read_thread.start()

    def _on_sigwinch(self, signum: int, frame: Any) -> None:
        if self.resize_handler:
            self.resize_handler()

    def _on_readable(self) -> None:
        try:
            data = os.read(self._fd, 1024)
            if len(data) > 0:
                decoded = data.decode("utf-8", errors="replace")
                self._handle_raw_input(decoded)
        except Exception:
            pass

    def _windows_read_loop(self) -> None:
        while not self._stop_read_event.is_set():
            try:
                # Read blocking from stdin file handle
                data = os.read(0, 1024)
                if len(data) > 0 and self._loop:
                    decoded = data.decode("utf-8", errors="replace")
                    self._loop.call_soon_threadsafe(self._handle_raw_input, decoded)
            except Exception:
                break

    def _handle_raw_input(self, data: str) -> None:
        if self.stdin_buffer:
            self.stdin_buffer.process(data)

    def setup_stdin_buffer(self) -> None:
        self.stdin_buffer = StdinBuffer({"timeout": 10})
        self.stdin_buffer.on("data", self._on_buffer_data)
        self.stdin_buffer.on("paste", self._on_buffer_paste)

    def _on_buffer_data(self, sequence: str) -> None:
        if self.keyboard_protocol_negotiation_pending:
            negotiation_sequence = self.read_keyboard_protocol_negotiation_sequence(sequence, True)
            if negotiation_sequence == "pending":
                return
            if self.handle_keyboard_protocol_negotiation_sequence(negotiation_sequence):
                return

        if self.keyboard_protocol_late_response_pending:
            negotiation_sequence = self.read_keyboard_protocol_negotiation_sequence(sequence, False)
            if negotiation_sequence == "pending":
                self.schedule_keyboard_protocol_negotiation_buffer_flush()
                return
            if self.handle_keyboard_protocol_negotiation_sequence(negotiation_sequence):
                return

        self.forward_input_sequence(sequence)

    def _on_buffer_paste(self, content: str) -> None:
        if self.input_handler:
            self.input_handler(f"\x1b[200~{content}\x1b[201~")

    def query_and_enable_kitty_protocol(self) -> None:
        self.setup_stdin_buffer()
        self.keyboard_protocol_pushed = True
        self.keyboard_protocol_negotiation_pending = True
        self.keyboard_protocol_late_response_pending = False
        self.clear_keyboard_protocol_negotiation_buffer()
        self.write(KITTY_KEYBOARD_PROTOCOL_QUERY)

        if self._loop:
            self.keyboard_protocol_fallback_timer = self._loop.call_later(
                KITTY_KEYBOARD_PROTOCOL_FALLBACK_TIMEOUT_MS / 1000.0,
                self._on_keyboard_protocol_fallback,
            )

    def _on_keyboard_protocol_fallback(self) -> None:
        self.keyboard_protocol_fallback_timer = None
        self.keyboard_protocol_negotiation_pending = False
        self.keyboard_protocol_late_response_pending = True
        if self.keyboard_protocol_negotiation_buffer == "\x1b":
            self.flush_keyboard_protocol_negotiation_buffer_as_input()
        else:
            self.schedule_keyboard_protocol_negotiation_buffer_flush()
        self.enable_modify_other_keys()

    def handle_keyboard_protocol_negotiation_sequence(self, negotiation_sequence: Any) -> bool:
        if not negotiation_sequence:
            return False
        if negotiation_sequence.get("type") == "kitty-flags":
            if negotiation_sequence.get("flags", 0) != 0 and not self._kitty_protocol_active:
                self._kitty_protocol_active = True
                set_kitty_protocol_active(True)
                self.keyboard_protocol_negotiation_pending = False
                self.keyboard_protocol_late_response_pending = True
                self.clear_keyboard_protocol_negotiation_buffer()
                self.clear_keyboard_protocol_fallback_timer()
            return True

        self.keyboard_protocol_negotiation_pending = False
        self.keyboard_protocol_late_response_pending = True
        self.clear_keyboard_protocol_negotiation_buffer()
        self.clear_keyboard_protocol_fallback_timer()
        self.enable_modify_other_keys()
        return True

    def read_keyboard_protocol_negotiation_sequence(
        self, sequence: str, allow_bare_escape_prefix: bool
    ) -> Union[dict[str, Any], Literal["pending"], None]:
        if self.keyboard_protocol_negotiation_buffer:
            buffered_sequence = self.keyboard_protocol_negotiation_buffer + sequence
            negotiation_sequence = parse_keyboard_protocol_negotiation_sequence(buffered_sequence)
            if negotiation_sequence:
                self.clear_keyboard_protocol_negotiation_buffer()
                return negotiation_sequence
            if is_keyboard_protocol_negotiation_sequence_prefix(
                buffered_sequence, allow_bare_escape_prefix
            ):
                self.set_keyboard_protocol_negotiation_buffer(buffered_sequence)
                return "pending"
            self.flush_keyboard_protocol_negotiation_buffer_as_input()

        negotiation_sequence = parse_keyboard_protocol_negotiation_sequence(sequence)
        if negotiation_sequence:
            return negotiation_sequence
        if is_keyboard_protocol_negotiation_sequence_prefix(sequence, allow_bare_escape_prefix):
            self.set_keyboard_protocol_negotiation_buffer(sequence)
            return "pending"
        return None

    def set_keyboard_protocol_negotiation_buffer(self, sequence: str) -> None:
        self.clear_keyboard_protocol_negotiation_buffer_flush_timer()
        self.keyboard_protocol_negotiation_buffer = sequence

    def clear_keyboard_protocol_negotiation_buffer(self) -> None:
        self.clear_keyboard_protocol_negotiation_buffer_flush_timer()
        self.keyboard_protocol_negotiation_buffer = ""

    def flush_keyboard_protocol_negotiation_buffer_as_input(self) -> None:
        if not self.keyboard_protocol_negotiation_buffer:
            return
        sequence = self.keyboard_protocol_negotiation_buffer
        self.clear_keyboard_protocol_negotiation_buffer()
        self.forward_input_sequence(sequence)

    def schedule_keyboard_protocol_negotiation_buffer_flush(self) -> None:
        if (
            not self.keyboard_protocol_negotiation_buffer
            or self.keyboard_protocol_buffer_flush_timer
        ):
            return
        if self._loop:
            self.keyboard_protocol_buffer_flush_timer = self._loop.call_later(
                KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS / 1000.0,
                self._flush_negotiation_buffer_callback,
            )

    def _flush_negotiation_buffer_callback(self) -> None:
        self.keyboard_protocol_buffer_flush_timer = None
        self.flush_keyboard_protocol_negotiation_buffer_as_input()

    def clear_keyboard_protocol_negotiation_buffer_flush_timer(self) -> None:
        if self.keyboard_protocol_buffer_flush_timer:
            self.keyboard_protocol_buffer_flush_timer.cancel()
            self.keyboard_protocol_buffer_flush_timer = None

    def forward_input_sequence(self, sequence: str) -> None:
        if not self.input_handler:
            return
        is_apple = sequence == "\r" and is_apple_terminal_session()
        input_data = normalize_apple_terminal_input(
            sequence, is_apple, is_apple and is_native_modifier_pressed("shift")
        )
        self.input_handler(input_data)

    def enable_modify_other_keys(self) -> None:
        if self._kitty_protocol_active or self._modify_other_keys_active:
            return
        self.write("\x1b[>4;2m")
        self._modify_other_keys_active = True

    def clear_keyboard_protocol_fallback_timer(self) -> None:
        if self.keyboard_protocol_fallback_timer:
            self.keyboard_protocol_fallback_timer.cancel()
            self.keyboard_protocol_fallback_timer = None

    def enable_windows_vt_input(self) -> None:
        if not IS_WINDOWS:
            return
        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            hStdin = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE = -10
            if hStdin != -1 and hStdin is not None:
                mode = ctypes.c_ulong()
                if kernel32.GetConsoleMode(hStdin, ctypes.byref(mode)):
                    ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
                    kernel32.SetConsoleMode(hStdin, mode.value | ENABLE_VIRTUAL_TERMINAL_INPUT)
        except Exception:
            pass

    async def drainInput(self, maxMs: int = 1000, idleMs: int = 50) -> None:
        should_disable = (
            self.keyboard_protocol_pushed
            or self._kitty_protocol_active
            or self.keyboard_protocol_negotiation_pending
        )
        self.keyboard_protocol_late_response_pending = False
        self.clear_keyboard_protocol_negotiation_buffer()
        self.clear_keyboard_protocol_fallback_timer()

        if should_disable:
            self.write("\x1b[<u")
            self.keyboard_protocol_pushed = False
            self._kitty_protocol_active = False
            set_kitty_protocol_active(False)

        self.keyboard_protocol_negotiation_pending = False
        if self._modify_other_keys_active:
            self.write("\x1b[>4;0m")
            self._modify_other_keys_active = False

        previous_handler = self.input_handler
        self.input_handler = None

        last_data_time = time.time()

        def temp_data_handler(data: str) -> None:
            nonlocal last_data_time
            last_data_time = time.time()

        # Swap handler temporarily
        self.input_handler = temp_data_handler

        end_time = time.time() + (maxMs / 1000.0)
        idle_seconds = idleMs / 1000.0

        try:
            while True:
                now = time.time()
                time_left = end_time - now
                if time_left <= 0:
                    break
                if now - last_data_time >= idle_seconds:
                    break
                await asyncio.sleep(min(idle_seconds, time_left))
        finally:
            self.input_handler = previous_handler

    def stop(self) -> None:
        self.clear_progress_interval()
        self.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE)

        # Disable bracketed paste mode
        self.write("\x1b[?2004l")

        should_disable = (
            self.keyboard_protocol_pushed
            or self._kitty_protocol_active
            or self.keyboard_protocol_negotiation_pending
        )
        self.keyboard_protocol_late_response_pending = False
        self.clear_keyboard_protocol_negotiation_buffer()
        self.clear_keyboard_protocol_fallback_timer()

        if should_disable:
            self.write("\x1b[<u")
            self.keyboard_protocol_pushed = False
            self._kitty_protocol_active = False
            set_kitty_protocol_active(False)

        self.keyboard_protocol_negotiation_pending = False
        if self._modify_other_keys_active:
            self.write("\x1b[>4;0m")
            self._modify_other_keys_active = False

        # Clean up StdinBuffer
        if self.stdin_buffer:
            self.stdin_buffer.destroy()
            self.stdin_buffer = None

        # Stop async reading
        if not IS_WINDOWS:
            if self._loop:
                try:
                    self._loop.remove_reader(self._fd)
                except Exception:
                    pass
            try:
                signal.signal(signal.SIGWINCH, signal.SIG_DFL)
            except ValueError:
                pass
        else:
            self._stop_read_event.set()
            # Let thread exit on next block read or standard exit

        self.input_handler = None
        self.resize_handler = None

        # Restore raw mode settings
        if self.was_raw is not None:
            if not IS_WINDOWS:
                try:
                    termios.tcsetattr(self._fd, termios.TCSADRAIN, self.was_raw)
                except Exception:
                    pass
            else:
                try:
                    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
                    hStdin = kernel32.GetStdHandle(-10)
                    kernel32.SetConsoleMode(hStdin, self.was_raw)
                except Exception:
                    pass

    def write(self, data: str) -> None:
        sys.stdout.write(data)
        sys.stdout.flush()
        if self.write_log_path:
            try:
                with open(self.write_log_path, "a", encoding="utf-8") as f:
                    f.write(data)
            except Exception:
                pass

    @property
    def columns(self) -> int:
        try:
            return os.get_terminal_size(sys.stdout.fileno()).columns
        except Exception:
            return int(os.environ.get("COLUMNS", 80))

    @property
    def rows(self) -> int:
        try:
            return os.get_terminal_size(sys.stdout.fileno()).lines
        except Exception:
            return int(os.environ.get("LINES", 24))

    def moveBy(self, lines: int) -> None:
        if lines > 0:
            self.write(f"\x1b[{lines}B")
        elif lines < 0:
            self.write(f"\x1b[{-lines}A")

    def hideCursor(self) -> None:
        self.write("\x1b[?25l")

    def showCursor(self) -> None:
        self.write("\x1b[?25h")

    def clearLine(self) -> None:
        self.write("\x1b[K")

    def clearFromCursor(self) -> None:
        self.write("\x1b[J")

    def clearScreen(self) -> None:
        self.write("\x1b[2J\x1b[H")

    def setTitle(self, title: str) -> None:
        self.write(f"\x1b]0;{title}\x07")

    def setProgress(self, active: bool) -> None:
        if active:
            self.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE)
            if not self.progress_task:
                self.progress_task = asyncio.create_task(self._progress_keepalive_loop())
        else:
            self.clear_progress_interval()
            self.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE)

    async def _progress_keepalive_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(TERMINAL_PROGRESS_KEEPALIVE_MS / 1000.0)
                self.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE)
        except asyncio.CancelledError:
            pass

    def clear_progress_interval(self) -> bool:
        if not self.progress_task:
            return False
        self.progress_task.cancel()
        self.progress_task = None
        return True
