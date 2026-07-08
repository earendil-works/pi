"""Ls tool."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Protocol

from pi_mono.agent.types import AgentTool, AgentToolResult
from pi_mono.coding_agent.core.tools.path_utils import path_exists, resolve_to_cwd
from pi_mono.coding_agent.core.tools.truncate import DEFAULT_MAX_BYTES, formatSize, truncateHead

DEFAULT_LIMIT = 500


class LsOperations(Protocol):
    async def exists(self, absolute_path: str) -> bool: ...
    async def stat(self, absolute_path: str) -> os.stat_result: ...
    async def readdir(self, absolute_path: str) -> list[str]: ...


class DefaultLsOperations:
    async def exists(self, absolute_path: str) -> bool:
        return await path_exists(absolute_path)

    async def stat(self, absolute_path: str) -> os.stat_result:
        return os.stat(absolute_path)

    async def readdir(self, absolute_path: str) -> list[str]:
        return os.listdir(absolute_path)


@dataclass
class LsToolOptions:
    operations: LsOperations | None = None


LS_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "Directory to list"},
        "limit": {"type": "number", "description": "Maximum number of entries"},
    },
}


async def execute_ls(
    cwd: str,
    path: str | None = None,
    *,
    limit: int | None = None,
    options: LsToolOptions | None = None,
) -> AgentToolResult:
    opts = options or LsToolOptions()
    ops = opts.operations or DefaultLsOperations()
    dir_path = resolve_to_cwd(path or ".", cwd)
    effective_limit = limit or DEFAULT_LIMIT
    if not await ops.exists(dir_path):
        raise FileNotFoundError(f"Path not found: {dir_path}")
    await ops.stat(dir_path)
    if not os.path.isdir(dir_path):
        raise NotADirectoryError(f"Not a directory: {dir_path}")
    entries = sorted(await ops.readdir(dir_path), key=lambda value: value.lower())
    results: list[str] = []
    entry_limit_reached = False
    for entry in entries:
        if len(results) >= effective_limit:
            entry_limit_reached = True
            break
        full_path = os.path.join(dir_path, entry)
        suffix = ""
        try:
            if os.path.isdir(full_path):
                suffix = "/"
        except OSError:
            continue
        results.append(entry + suffix)
    raw_output = "\n".join(results) if results else "(empty directory)"
    truncation = truncateHead(raw_output, {"maxLines": effective_limit})
    details: dict[str, Any] = {}
    notices: list[str] = []
    if entry_limit_reached:
        notices.append(f"{effective_limit} entries limit")
        details["entryLimitReached"] = effective_limit
    if truncation["truncated"]:
        notices.append(f"{formatSize(DEFAULT_MAX_BYTES)} limit")
        details["truncation"] = truncation
    output = truncation["content"]
    if notices:
        output += f"\n\n[Truncated: {', '.join(notices)}]"
    return {
        "content": [{"type": "text", "text": output}],
        "details": details or None,
    }


def create_ls_tool(cwd: str, options: LsToolOptions | None = None) -> AgentTool:
    opts = options or LsToolOptions()

    class LsTool:
        name = "ls"
        label = "ls"
        description = "List directory contents."
        parameters = LS_PARAMETERS
        executionMode = None

        async def execute(
            self,
            tool_call_id: str,
            params: dict[str, Any],
            signal: Any = None,
            on_update: Any = None,
        ) -> AgentToolResult:
            return await execute_ls(
                cwd,
                params.get("path"),
                limit=params.get("limit"),
                options=opts,
            )

    return LsTool()  # type: ignore[return-value]
