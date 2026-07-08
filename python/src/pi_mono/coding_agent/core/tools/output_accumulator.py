"""Incremental streaming output accumulator for bash tool."""

from __future__ import annotations

import os
import secrets
import tempfile
from dataclasses import dataclass
from typing import BinaryIO

from pi_mono.coding_agent.core.tools.truncate import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    TruncationResult,
    truncateTail,
)


@dataclass
class OutputSnapshot:
    content: str
    truncation: TruncationResult
    fullOutputPath: str | None = None


class OutputAccumulator:
    """Incrementally tracks streaming output with bounded memory."""

    def __init__(
        self,
        *,
        max_lines: int = DEFAULT_MAX_LINES,
        max_bytes: int = DEFAULT_MAX_BYTES,
        temp_file_prefix: str = "pi-output",
    ) -> None:
        self._max_lines = max_lines
        self._max_bytes = max_bytes
        self._max_rolling_bytes = max(self._max_bytes * 2, 1)
        self._temp_file_prefix = temp_file_prefix

        self._tail_text = ""
        self._tail_bytes = 0
        self._tail_starts_at_line_boundary = True
        self._total_raw_bytes = 0
        self._total_decoded_bytes = 0
        self._completed_lines = 0
        self._total_lines = 0
        self._current_line_bytes = 0
        self._has_open_line = False
        self._finished = False

        self._temp_file_path: str | None = None
        self._temp_file_stream: BinaryIO | None = None
        self._raw_chunks: list[bytes] = []

    def append(self, data: bytes) -> None:
        if self._finished:
            raise RuntimeError("Cannot append to a finished output accumulator")

        self._total_raw_bytes += len(data)
        text = data.decode("utf-8", errors="replace")
        self._append_decoded_text(text)

        if self._temp_file_stream is not None or self._should_use_temp_file():
            self._ensure_temp_file()
            if self._temp_file_stream is not None:
                self._temp_file_stream.write(data)
        elif data:
            self._raw_chunks.append(data)

    def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        if self._should_use_temp_file():
            self._ensure_temp_file()

    def snapshot(self, *, persist_if_truncated: bool = False) -> OutputSnapshot:
        tail_truncation = truncateTail(
            self._get_snapshot_text(),
            {"maxLines": self._max_lines, "maxBytes": self._max_bytes},
        )
        truncated = (
            self._total_lines > self._max_lines or self._total_decoded_bytes > self._max_bytes
        )
        truncated_by = None
        if truncated:
            truncated_by = tail_truncation.get("truncatedBy") or (
                "bytes" if self._total_decoded_bytes > self._max_bytes else "lines"
            )
        truncation: TruncationResult = {
            **tail_truncation,
            "truncated": truncated,
            "truncatedBy": truncated_by,
            "totalLines": self._total_lines,
            "totalBytes": self._total_decoded_bytes,
            "maxLines": self._max_lines,
            "maxBytes": self._max_bytes,
        }

        if persist_if_truncated and truncation["truncated"]:
            self._ensure_temp_file()

        return OutputSnapshot(
            content=truncation["content"],
            truncation=truncation,
            fullOutputPath=self._temp_file_path,
        )

    def close_temp_file(self) -> None:
        if self._temp_file_stream is None:
            return
        stream = self._temp_file_stream
        self._temp_file_stream = None
        stream.close()

    def get_last_line_bytes(self) -> int:
        return self._current_line_bytes

    def _append_decoded_text(self, text: str) -> None:
        if not text:
            return
        text_bytes = len(text.encode("utf-8"))
        self._total_decoded_bytes += text_bytes
        self._tail_text += text
        self._tail_bytes += text_bytes
        if self._tail_bytes > self._max_rolling_bytes * 2:
            self._trim_tail()

        newlines = text.count("\n")
        if newlines == 0:
            self._current_line_bytes += text_bytes
            self._has_open_line = True
        else:
            last_newline = text.rfind("\n")
            self._completed_lines += newlines
            tail = text[last_newline + 1 :]
            self._current_line_bytes = len(tail.encode("utf-8"))
            self._has_open_line = bool(tail)
        self._total_lines = self._completed_lines + (1 if self._has_open_line else 0)

    def _trim_tail(self) -> None:
        encoded = self._tail_text.encode("utf-8")
        if len(encoded) <= self._max_rolling_bytes:
            self._tail_bytes = len(encoded)
            return
        start = len(encoded) - self._max_rolling_bytes
        while start < len(encoded) and (encoded[start] & 0xC0) == 0x80:
            start += 1
        self._tail_starts_at_line_boundary = start == 0 or encoded[start - 1] == 0x0A
        self._tail_text = encoded[start:].decode("utf-8", errors="replace")
        self._tail_bytes = len(self._tail_text.encode("utf-8"))

    def _get_snapshot_text(self) -> str:
        if self._tail_starts_at_line_boundary:
            return self._tail_text
        first_newline = self._tail_text.find("\n")
        if first_newline == -1:
            return self._tail_text
        return self._tail_text[first_newline + 1 :]

    def _should_use_temp_file(self) -> bool:
        return (
            self._total_raw_bytes > self._max_bytes
            or self._total_decoded_bytes > self._max_bytes
            or self._total_lines > self._max_lines
        )

    def _ensure_temp_file(self) -> None:
        if self._temp_file_path is not None:
            return
        file_id = secrets.token_hex(8)
        self._temp_file_path = os.path.join(
            tempfile.gettempdir(), f"{self._temp_file_prefix}-{file_id}.log"
        )
        self._temp_file_stream = open(self._temp_file_path, "wb")
        for chunk in self._raw_chunks:
            self._temp_file_stream.write(chunk)
        self._raw_chunks = []
