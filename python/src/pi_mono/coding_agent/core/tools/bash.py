"""Bash tool."""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from pi_mono.agent.types import AgentTool, AgentToolResult
from pi_mono.coding_agent.core.tools.output_accumulator import OutputAccumulator
from pi_mono.coding_agent.core.tools.truncate import DEFAULT_MAX_BYTES, formatSize
from pi_mono.utils.child_process import wait_for_child_process
from pi_mono.utils.shell import (
    get_shell_config,
    get_shell_env,
    kill_process_tree,
    track_detached_child_pid,
    untrack_detached_child_pid,
)


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


class LocalBashOperations:
    def __init__(self, shell_path: str | None = None) -> None:
        self._shell_path = shell_path

    async def exec(
        self,
        command: str,
        cwd: str,
        *,
        on_data: Callable[[bytes], None],
        signal: Any = None,
        timeout: float | None = None,
        env: dict[str, str] | None = None,
    ) -> dict[str, int | None]:
        if not os.path.isdir(cwd):
            raise RuntimeError(
                f"Working directory does not exist: {cwd}\nCannot execute bash commands."
            )
        if signal is not None and getattr(signal, "aborted", False):
            raise RuntimeError("aborted")

        shell_config = get_shell_config(self._shell_path)
        command_from_stdin = shell_config.get("commandTransport") == "stdin"
        spawn_args = list(shell_config["args"])
        if not command_from_stdin:
            spawn_args.append(command)

        process = await asyncio.create_subprocess_exec(
            shell_config["shell"],
            *spawn_args,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE if command_from_stdin else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env or get_shell_env(),
            start_new_session=sys.platform != "win32",
        )
        if process.pid is not None:
            track_detached_child_pid(process.pid)

        try:
            if command_from_stdin and process.stdin is not None:
                process.stdin.write(command.encode("utf-8"))
                await process.stdin.drain()
                process.stdin.close()

            if process.stdout is None:
                raise RuntimeError("Failed to capture command output")

            def on_chunk(data: bytes) -> None:
                if signal is not None and getattr(signal, "aborted", False):
                    if process.pid is not None:
                        kill_process_tree(process.pid)
                    raise RuntimeError("aborted")
                on_data(data)

            try:
                if timeout is None:
                    exit_code = await wait_for_child_process(process, on_data=on_chunk)
                else:
                    exit_code = await asyncio.wait_for(
                        wait_for_child_process(process, on_data=on_chunk),
                        timeout=timeout,
                    )
            except asyncio.TimeoutError:
                if process.pid is not None:
                    kill_process_tree(process.pid)
                raise RuntimeError(f"timeout:{timeout}") from None
            if signal is not None and getattr(signal, "aborted", False):
                raise RuntimeError("aborted")
            return {"exitCode": exit_code}
        except asyncio.TimeoutError:
            if process.pid is not None:
                kill_process_tree(process.pid)
            raise RuntimeError(f"timeout:{timeout}") from None
        finally:
            if process.pid is not None:
                untrack_detached_child_pid(process.pid)


@dataclass
class BashToolOptions:
    operations: BashOperations | None = None
    command_prefix: str | None = None


BASH_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "command": {"type": "string", "description": "Bash command to execute"},
        "timeout": {"type": "number", "description": "Timeout in seconds (optional)"},
    },
    "required": ["command"],
}


def _format_bash_output(
    snapshot: Any, accumulator: OutputAccumulator, *, empty_text: str = "(no output)"
) -> tuple[str, dict[str, Any] | None]:
    truncation = snapshot.truncation
    text = snapshot.content or empty_text
    details: dict[str, Any] | None = None
    if truncation.get("truncated"):
        details = {
            "truncation": truncation,
            "fullOutputPath": snapshot.fullOutputPath,
        }
        start_line = truncation["totalLines"] - truncation["outputLines"] + 1
        end_line = truncation["totalLines"]
        if truncation.get("lastLinePartial"):
            last_line_size = formatSize(accumulator.get_last_line_bytes())
            text += (
                f"\n\n[Showing last {formatSize(truncation['outputBytes'])} of line {end_line} "
                f"(line is {last_line_size}). Full output: {snapshot.fullOutputPath}]"
            )
        elif truncation.get("truncatedBy") == "lines":
            text += (
                f"\n\n[Showing lines {start_line}-{end_line} of {truncation['totalLines']}. "
                f"Full output: {snapshot.fullOutputPath}]"
            )
        else:
            text += (
                f"\n\n[Showing lines {start_line}-{end_line} of {truncation['totalLines']} "
                f"({formatSize(DEFAULT_MAX_BYTES)} limit). Full output: {snapshot.fullOutputPath}]"
            )
    return text, details


async def execute_bash(
    cwd: str,
    command: str,
    *,
    timeout: float | None = None,
    options: BashToolOptions | None = None,
    signal: Any = None,
) -> AgentToolResult:
    opts = options or BashToolOptions()
    ops = opts.operations or LocalBashOperations()
    resolved_command = f"{opts.command_prefix}\n{command}" if opts.command_prefix else command
    output = OutputAccumulator(temp_file_prefix="pi-bash")
    accepting_output = True

    def on_data(data: bytes) -> None:
        if not accepting_output:
            return
        output.append(data)

    try:
        result = await ops.exec(
            resolved_command,
            cwd,
            on_data=on_data,
            signal=signal,
            timeout=timeout,
        )
    except RuntimeError as error:
        accepting_output = False
        output.finish()
        snapshot = output.snapshot(persist_if_truncated=True)
        output.close_temp_file()
        text, _details = _format_bash_output(snapshot, output, empty_text="")
        if str(error) == "aborted":
            raise RuntimeError(
                f"{text}\n\nCommand aborted" if text else "Command aborted"
            ) from error
        if str(error).startswith("timeout:"):
            timeout_secs = str(error).split(":", 1)[1]
            raise RuntimeError(
                f"{text}\n\nCommand timed out after {timeout_secs} seconds"
                if text
                else f"Command timed out after {timeout_secs} seconds"
            ) from error
        raise
    finally:
        accepting_output = False

    output.finish()
    snapshot = output.snapshot(persist_if_truncated=True)
    output.close_temp_file()
    text, details = _format_bash_output(snapshot, output)
    exit_code = result.get("exitCode")
    if exit_code not in (0, None):
        raise RuntimeError(f"{text}\n\nCommand exited with code {exit_code}")
    return {"content": [{"type": "text", "text": text}], "details": details}


def create_bash_tool(cwd: str, options: BashToolOptions | None = None) -> AgentTool:
    opts = options or BashToolOptions()

    class BashTool:
        name = "bash"
        label = "bash"
        description = (
            "Execute a bash command in the current working directory. Returns stdout and stderr. "
            f"Output is truncated to last lines or {DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first). "
            "If truncated, full output is saved to a temp file."
        )
        parameters = BASH_PARAMETERS
        executionMode = None

        async def execute(
            self,
            tool_call_id: str,
            params: dict[str, Any],
            signal: Any = None,
            on_update: Any = None,
        ) -> AgentToolResult:
            return await execute_bash(
                cwd,
                params["command"],
                timeout=params.get("timeout"),
                options=opts,
                signal=signal,
            )

    return BashTool()  # type: ignore[return-value]
