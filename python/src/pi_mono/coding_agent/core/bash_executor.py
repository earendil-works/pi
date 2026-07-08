"""Bash command execution with streaming support and cancellation."""

from __future__ import annotations

import os
import secrets
import tempfile
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from pi_mono.coding_agent.core.tools.truncate import DEFAULT_MAX_BYTES, truncateTail
from pi_mono.utils.ansi import strip_ansi
from pi_mono.utils.shell import sanitize_binary_output


class BashOperations(Protocol):
    async def exec(
        self,
        command: str,
        cwd: str,
        *,
        on_data: Callable[[bytes], None],
        signal: Any = None,
        timeout: float | None = None,
        env: dict[str, str] | None = None,
    ) -> dict[str, int | None]: ...


@dataclass
class BashExecutorOptions:
    on_chunk: Callable[[str], None] | None = None
    signal: Any = None


@dataclass
class BashResult:
    output: str
    exit_code: int | None
    cancelled: bool
    truncated: bool
    full_output_path: str | None = None


async def execute_bash_with_operations(
    command: str,
    cwd: str,
    operations: BashOperations,
    options: BashExecutorOptions | None = None,
) -> BashResult:
    output_chunks: list[str] = []
    output_bytes = 0
    max_output_bytes = DEFAULT_MAX_BYTES * 2
    temp_file_path: str | None = None
    temp_file_handle: Any = None
    total_bytes = 0

    def ensure_temp_file() -> None:
        nonlocal temp_file_path, temp_file_handle
        if temp_file_path is not None:
            return
        temp_file_path = os.path.join(tempfile.gettempdir(), f"pi-bash-{secrets.token_hex(8)}.log")
        temp_file_handle = open(temp_file_path, "w", encoding="utf-8")
        for chunk in output_chunks:
            temp_file_handle.write(chunk)

    def on_data(data: bytes) -> None:
        nonlocal output_bytes, total_bytes
        total_bytes += len(data)
        text = sanitize_binary_output(strip_ansi(data.decode("utf-8", errors="replace"))).replace(
            "\r", ""
        )

        if total_bytes > DEFAULT_MAX_BYTES:
            ensure_temp_file()

        if temp_file_handle is not None:
            temp_file_handle.write(text)

        output_chunks.append(text)
        output_bytes += len(text)
        while output_bytes > max_output_bytes and len(output_chunks) > 1:
            removed = output_chunks.pop(0)
            output_bytes -= len(removed)

        if options and options.on_chunk:
            options.on_chunk(text)

    try:
        result = await operations.exec(
            command, cwd, on_data=on_data, signal=options.signal if options else None
        )
        full_output = "".join(output_chunks)
        truncation_result = truncateTail(full_output)
        if truncation_result["truncated"]:
            ensure_temp_file()
        if temp_file_handle is not None:
            temp_file_handle.close()
        cancelled = bool(
            options and options.signal is not None and getattr(options.signal, "aborted", False)
        )
        return BashResult(
            output=truncation_result["content"] if truncation_result["truncated"] else full_output,
            exit_code=None if cancelled else result.get("exitCode"),
            cancelled=cancelled,
            truncated=bool(truncation_result["truncated"]),
            full_output_path=temp_file_path,
        )
    except Exception as err:
        if options and options.signal is not None and getattr(options.signal, "aborted", False):
            full_output = "".join(output_chunks)
            truncation_result = truncateTail(full_output)
            if truncation_result["truncated"]:
                ensure_temp_file()
            if temp_file_handle is not None:
                temp_file_handle.close()
            return BashResult(
                output=(
                    truncation_result["content"] if truncation_result["truncated"] else full_output
                ),
                exit_code=None,
                cancelled=True,
                truncated=bool(truncation_result["truncated"]),
                full_output_path=temp_file_path,
            )
        if temp_file_handle is not None:
            temp_file_handle.close()
        raise err
