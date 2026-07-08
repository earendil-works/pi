"""Strict LF-only JSONL framing helpers.

Ported from packages/coding-agent/src/modes/rpc/jsonl.ts.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any


def serialize_json_line(value: Any) -> str:
    return f"{json.dumps(value, separators=(',', ':'))}\n"


class JsonlLineReader:
    """Incrementally read LF-delimited JSONL records from a byte stream."""

    def __init__(self, on_line: Callable[[str], None]) -> None:
        self._on_line = on_line
        self._buffer = ""

    def feed(self, chunk: str) -> None:
        self._buffer += chunk
        while True:
            newline_index = self._buffer.find("\n")
            if newline_index == -1:
                return
            line = self._buffer[:newline_index]
            self._buffer = self._buffer[newline_index + 1 :]
            if line.endswith("\r"):
                line = line[:-1]
            self._on_line(line)

    def flush(self) -> None:
        if self._buffer:
            line = self._buffer
            self._buffer = ""
            if line.endswith("\r"):
                line = line[:-1]
            self._on_line(line)


def attach_jsonl_line_reader(
    stream: asyncio.StreamReader,
    on_line: Callable[[str], None],
) -> Callable[[], None]:
    reader = JsonlLineReader(on_line)
    task: asyncio.Task[None] | None = None

    async def _read_loop() -> None:
        while True:
            chunk = await stream.readline()
            if not chunk:
                reader.flush()
                return
            reader.feed(chunk.decode("utf-8", errors="replace"))

    task = asyncio.create_task(_read_loop())

    def detach() -> None:
        if task is not None and not task.done():
            task.cancel()

    return detach
