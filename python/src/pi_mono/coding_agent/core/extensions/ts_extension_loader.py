"""Load TypeScript extensions via a Node.js JSON-RPC host."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any

from pi_mono.coding_agent.core.extensions.types import (
    Extension,
    RegisteredCommand,
    RegisteredTool,
    ToolDefinition,
)
from pi_mono.coding_agent.core.source_info import create_synthetic_source_info
from pi_mono.core.event_bus import EventBusController
from pi_mono.utils.paths import resolve_path

_HOST_SCRIPT = Path(__file__).resolve().parents[5] / "scripts" / "ts_extension_host.mjs"


class TsExtensionHost:
    """Manages a single Node subprocess for TypeScript extension RPC."""

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._request_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    @staticmethod
    def is_available() -> bool:
        return shutil.which("node") is not None and _HOST_SCRIPT.is_file()

    async def start(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        if not self.is_available():
            raise RuntimeError("Node.js or ts_extension_host.mjs is not available")

        env = os.environ.copy()
        repo_root = Path(__file__).resolve().parents[6]
        if (repo_root / "package.json").exists():
            env.setdefault("PI_MONO_ROOT", str(repo_root))

        self._process = await asyncio.create_subprocess_exec(
            "node",
            str(_HOST_SCRIPT),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        assert self._process.stdout is not None
        self._reader_task = asyncio.create_task(self._read_stdout())

    async def stop(self) -> None:
        if self._process is None:
            return
        try:
            await self.request("shutdown", {})
        except Exception:
            pass
        if self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=2)
            except TimeoutError:
                self._process.kill()
        if self._reader_task is not None:
            self._reader_task.cancel()
        self._process = None
        self._reader_task = None

    async def _read_stdout(self) -> None:
        if self._process is None or self._process.stdout is None:
            return
        while True:
            line = await self._process.stdout.readline()
            if not line:
                break
            try:
                payload = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                continue
            request_id = payload.get("id")
            future = self._pending.pop(request_id, None) if isinstance(request_id, int) else None
            if future is None or future.done():
                continue
            if "error" in payload:
                error = payload["error"]
                message = error.get("message") if isinstance(error, dict) else str(error)
                future.set_exception(RuntimeError(message))
            else:
                future.set_result(payload.get("result", {}))

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            await self.start()
            assert self._process is not None and self._process.stdin is not None
            self._request_id += 1
            request_id = self._request_id
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending[request_id] = future
            payload = json.dumps({"id": request_id, "method": method, "params": params})
            self._process.stdin.write(f"{payload}\n".encode("utf-8"))
            await self._process.stdin.drain()
        return await future


_host: TsExtensionHost | None = None


async def _get_host() -> TsExtensionHost:
    global _host
    if _host is None:
        _host = TsExtensionHost()
    return _host


def _build_extension_from_host_result(
    extension_path: str,
    resolved_path: str,
    host: TsExtensionHost,
    load_result: dict[str, Any],
) -> Extension:
    extension = Extension(
        path=extension_path,
        resolved_path=resolved_path,
        source_info=create_synthetic_source_info(
            extension_path, source="package", base_dir=os.path.dirname(resolved_path)
        ),
    )

    for tool_data in load_result.get("tools", []):
        if not isinstance(tool_data, dict):
            continue
        tool_name = str(tool_data.get("name", ""))
        if not tool_name:
            continue

        async def execute_tool(
            _tool_call_id: str,
            params: dict[str, Any],
            _signal: Any | None = None,
            _on_update: Any | None = None,
            _on_queued: Any | None = None,
            *,
            _tool_name: str = tool_name,
            _extension_path: str = extension_path,
            _host_ref: TsExtensionHost = host,
        ) -> dict[str, Any]:
            result = await _host_ref.request(
                "execute_tool",
                {
                    "extensionPath": _extension_path,
                    "toolName": _tool_name,
                    "args": params,
                },
            )
            return result

        definition = ToolDefinition(
            name=tool_name,
            label=str(tool_data.get("label") or tool_name),
            description=str(tool_data.get("description") or ""),
            parameters=tool_data.get("parameters") or {"type": "object", "properties": {}},
            execute=execute_tool,
        )
        extension.tools[tool_name] = RegisteredTool(
            definition=definition, source_info=extension.source_info
        )

    for command_data in load_result.get("commands", []):
        if not isinstance(command_data, dict):
            continue
        command_name = str(command_data.get("name", ""))
        if not command_name:
            continue

        async def execute_command(
            args: str,
            _ctx: Any,
            *,
            _command_name: str = command_name,
            _extension_path: str = extension_path,
            _host_ref: TsExtensionHost = host,
        ) -> None:
            await _host_ref.request(
                "execute_command",
                {
                    "extensionPath": _extension_path,
                    "commandName": _command_name,
                    "args": args,
                },
            )

        extension.commands[command_name] = RegisteredCommand(
            name=command_name,
            source_info=extension.source_info,
            handler=execute_command,
            description=str(command_data.get("description") or ""),
        )

    return extension


async def load_ts_extensions(
    paths: list[str],
    cwd: str,
    event_bus: EventBusController | None = None,
    *,
    existing_extensions: list[Extension] | None = None,
    existing_errors: list[dict[str, str]] | None = None,
) -> tuple[list[Extension], list[dict[str, str]]]:
    del event_bus  # TS host manages its own event bus for now
    extensions = list(existing_extensions or [])
    errors = list(existing_errors or [])
    if not paths:
        return extensions, errors
    if not TsExtensionHost.is_available():
        for path in paths:
            errors.append(
                {
                    "path": path,
                    "error": "TypeScript extensions require Node.js and the pi-mono repository ts_extension_host.mjs",
                }
            )
        return extensions, errors

    host = await _get_host()
    resolved_cwd = resolve_path(cwd)
    for extension_path in paths:
        resolved_path = resolve_path(extension_path, resolved_cwd)
        try:
            load_result = await host.request(
                "load",
                {"path": extension_path, "cwd": resolved_cwd},
            )
            extension = _build_extension_from_host_result(
                extension_path, resolved_path, host, load_result
            )
            extensions.append(extension)
        except Exception as error:
            errors.append(
                {"path": extension_path, "error": f"Failed to load TypeScript extension: {error}"}
            )
    return extensions, errors
