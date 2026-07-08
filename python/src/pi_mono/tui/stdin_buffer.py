import re
import asyncio
from typing import Any, Callable

ESC = "\x1b"
BRACKETED_PASTE_START = "\x1b[200~"
BRACKETED_PASTE_END = "\x1b[201~"


def is_complete_csi_sequence(data: str) -> str:
    if not data.startswith(f"{ESC}["):
        return "complete"

    if len(data) < 3:
        return "incomplete"

    payload = data[2:]
    last_char = payload[-1]
    last_char_code = ord(last_char)

    if 0x40 <= last_char_code <= 0x7E:
        if payload.startswith("<"):
            # Special handling for SGR mouse sequences: ESC[<B;X;Ym or ESC[<B;X;YM
            if re.match(r"^<\d+;\d+;\d+[Mm]$", payload):
                return "complete"
            if last_char in ("M", "m"):
                parts = payload[1:-1].split(";")
                if len(parts) == 3 and all(p.isdigit() for p in parts):
                    return "complete"
            return "incomplete"
        return "complete"

    return "incomplete"


def is_complete_osc_sequence(data: str) -> str:
    if not data.startswith(f"{ESC}]"):
        return "complete"
    if data.endswith(f"{ESC}\\") or data.endswith("\x07"):
        return "complete"
    return "incomplete"


def is_complete_dcs_sequence(data: str) -> str:
    if not data.startswith(f"{ESC}P"):
        return "complete"
    if data.endswith(f"{ESC}\\"):
        return "complete"
    return "incomplete"


def is_complete_apc_sequence(data: str) -> str:
    if not data.startswith(f"{ESC}_"):
        return "complete"
    if data.endswith(f"{ESC}\\"):
        return "complete"
    return "incomplete"


def is_complete_sequence(data: str) -> str:
    if not data.startswith(ESC):
        return "not-escape"

    if len(data) == 1:
        return "incomplete"

    after_esc = data[1:]

    # CSI sequences: ESC [
    if after_esc.startswith("["):
        if after_esc.startswith("[M"):
            return "complete" if len(data) >= 6 else "incomplete"
        return is_complete_csi_sequence(data)

    # OSC sequences: ESC ]
    if after_esc.startswith("]"):
        return is_complete_osc_sequence(data)

    # DCS sequences: ESC P
    if after_esc.startswith("P"):
        return is_complete_dcs_sequence(data)

    # APC sequences: ESC _
    if after_esc.startswith("_"):
        return is_complete_apc_sequence(data)

    # SS3 sequences: ESC O
    if after_esc.startswith("O"):
        return "complete" if len(after_esc) >= 2 else "incomplete"

    # Meta key sequences: ESC followed by a single character
    if len(after_esc) == 1:
        return "complete"

    return "complete"


def parse_unmodified_kitty_printable_codepoint(sequence: str) -> int | None:
    match = re.match(r"^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$", sequence)
    if not match:
        return None
    codepoint = int(match.group(1))
    return codepoint if codepoint >= 32 else None


def extract_complete_sequences(buffer: str) -> dict[str, Any]:
    sequences: list[str] = []
    pos = 0

    while pos < len(buffer):
        remaining = buffer[pos:]

        if remaining.startswith(ESC):
            seq_end = 1
            while seq_end <= len(remaining):
                candidate = remaining[:seq_end]
                status = is_complete_sequence(candidate)

                if status == "complete":
                    if candidate == "\x1b\x1b" and seq_end < len(remaining):
                        next_char = remaining[seq_end]
                        if next_char in ("[", "]", "O", "P", "_"):
                            sequences.append(ESC)
                            pos += 1
                            break
                    sequences.append(candidate)
                    pos += seq_end
                    break
                elif status == "incomplete":
                    seq_end += 1
                else:
                    sequences.append(candidate)
                    pos += seq_end
                    break

            if seq_end > len(remaining):
                return {"sequences": sequences, "remainder": remaining}
        else:
            sequences.append(remaining[0])
            pos += 1

    return {"sequences": sequences, "remainder": ""}


class StdinBuffer:
    def __init__(self, options: dict[str, Any] | None = None) -> None:
        opts = options or {}
        self.timeout_ms = opts.get("timeout", 10)
        self.buffer = ""
        self.timeout: asyncio.TimerHandle | None = None
        self.paste_mode = False
        self.paste_buffer = ""
        self.pending_kitty_printable_codepoint: int | None = None

        self._listeners: dict[str, list[Callable[..., None]]] = {
            "data": [],
            "paste": [],
        }

    def on(self, event: str, callback: Callable[..., None]) -> None:
        if event in self._listeners:
            self._listeners[event].append(callback)

    def remove_listener(self, event: str, callback: Callable[..., None]) -> None:
        if event in self._listeners:
            try:
                self._listeners[event].remove(callback)
            except ValueError:
                pass

    def emit(self, event: str, *args: Any) -> None:
        if event in self._listeners:
            # Create a copy of the list of listeners so that listeners mutating
            # the active callbacks list do not raise exceptions during iteration
            for cb in list(self._listeners[event]):
                cb(*args)

    def process(self, data: str | bytes) -> None:
        if self.timeout is not None:
            self.timeout.cancel()
            self.timeout = None

        if isinstance(data, bytes):
            if len(data) == 1 and data[0] > 127:
                byte = data[0] - 128
                string_data = f"\x1b{chr(byte)}"
            else:
                string_data = data.decode("utf-8", errors="replace")
        else:
            string_data = data

        if len(string_data) == 0 and len(self.buffer) == 0:
            self._emit_data_sequence("")
            return

        self.buffer += string_data

        if self.paste_mode:
            self.paste_buffer += self.buffer
            self.buffer = ""

            end_index = self.paste_buffer.find(BRACKETED_PASTE_END)
            if end_index != -1:
                pasted_content = self.paste_buffer[:end_index]
                remaining = self.paste_buffer[end_index + len(BRACKETED_PASTE_END) :]

                self.paste_mode = False
                self.paste_buffer = ""
                self.pending_kitty_printable_codepoint = None

                self.emit("paste", pasted_content)

                if len(remaining) > 0:
                    self.process(remaining)
            return

        start_index = self.buffer.find(BRACKETED_PASTE_START)
        if start_index != -1:
            if start_index > 0:
                before_paste = self.buffer[:start_index]
                result = extract_complete_sequences(before_paste)
                for sequence in result["sequences"]:
                    self._emit_data_sequence(sequence)

            self.pending_kitty_printable_codepoint = None
            self.buffer = self.buffer[start_index + len(BRACKETED_PASTE_START) :]
            self.paste_mode = True
            self.paste_buffer = self.buffer
            self.buffer = ""

            end_index = self.paste_buffer.find(BRACKETED_PASTE_END)
            if end_index != -1:
                pasted_content = self.paste_buffer[:end_index]
                remaining = self.paste_buffer[end_index + len(BRACKETED_PASTE_END) :]

                self.paste_mode = False
                self.paste_buffer = ""
                self.pending_kitty_printable_codepoint = None

                self.emit("paste", pasted_content)

                if len(remaining) > 0:
                    self.process(remaining)
            return

        result = extract_complete_sequences(self.buffer)
        self.buffer = result["remainder"]

        for sequence in result["sequences"]:
            self._emit_data_sequence(sequence)

        if len(self.buffer) > 0:
            try:
                loop = asyncio.get_running_loop()
                self.timeout = loop.call_later(self.timeout_ms / 1000.0, self._on_timeout)
            except RuntimeError:
                pass

    def _on_timeout(self) -> None:
        self.timeout = None
        flushed = self.flush()
        for sequence in flushed:
            self._emit_data_sequence(sequence)

    def _emit_data_sequence(self, sequence: str) -> None:
        raw_codepoint = ord(sequence[0]) if len(sequence) == 1 else None
        if raw_codepoint is not None and raw_codepoint == self.pending_kitty_printable_codepoint:
            self.pending_kitty_printable_codepoint = None
            return

        self.pending_kitty_printable_codepoint = parse_unmodified_kitty_printable_codepoint(
            sequence
        )
        self.emit("data", sequence)

    def flush(self) -> list[str]:
        if self.timeout is not None:
            self.timeout.cancel()
            self.timeout = None

        if len(self.buffer) == 0:
            return []

        flushed_seqs = [self.buffer]
        self.buffer = ""
        self.pending_kitty_printable_codepoint = None
        return flushed_seqs

    def clear(self) -> None:
        if self.timeout is not None:
            self.timeout.cancel()
            self.timeout = None
        self.buffer = ""
        self.paste_mode = False
        self.paste_buffer = ""
        self.pending_kitty_printable_codepoint = None

    def getBuffer(self) -> str:
        return self.buffer

    def destroy(self) -> None:
        self.clear()
