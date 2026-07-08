"""Write tool."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Protocol

from pi_mono.agent.types import AgentTool, AgentToolResult
from pi_mono.coding_agent.core.tools.file_mutation_queue import with_file_mutation_queue
from pi_mono.coding_agent.core.tools.path_utils import resolve_to_cwd


class WriteOperations(Protocol):
    async def write_file(self, absolute_path: str, content: str) -> None: ...
    async def mkdir(self, directory: str) -> None: ...


class DefaultWriteOperations:
    async def write_file(self, absolute_path: str, content: str) -> None:
        with open(absolute_path, "w", encoding="utf-8") as handle:
            handle.write(content)

    async def mkdir(self, directory: str) -> None:
        os.makedirs(directory, exist_ok=True)


@dataclass
class WriteToolOptions:
    operations: WriteOperations | None = None


WRITE_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "Path to the file to write"},
        "content": {"type": "string", "description": "Content to write to the file"},
    },
    "required": ["path", "content"],
}


async def execute_write(
    cwd: str,
    path: str,
    content: str,
    *,
    options: WriteToolOptions | None = None,
    signal: Any = None,
) -> AgentToolResult:
    opts = options or WriteToolOptions()
    ops = opts.operations or DefaultWriteOperations()
    absolute_path = resolve_to_cwd(path, cwd)
    directory = os.path.dirname(absolute_path)

    async def run() -> AgentToolResult:
        if signal is not None and getattr(signal, "aborted", False):
            raise RuntimeError("Operation aborted")
        if directory:
            await ops.mkdir(directory)
        if signal is not None and getattr(signal, "aborted", False):
            raise RuntimeError("Operation aborted")
        await ops.write_file(absolute_path, content)
        return {
            "content": [
                {"type": "text", "text": f"Successfully wrote {len(content)} bytes to {path}"}
            ],
            "details": None,
        }

    return await with_file_mutation_queue(absolute_path, run)


def create_write_tool(cwd: str, options: WriteToolOptions | None = None) -> AgentTool:
    opts = options or WriteToolOptions()

    class WriteTool:
        name = "write"
        label = "write"
        description = (
            "Write content to a file. Creates the file if it doesn't exist, overwrites if it does."
        )
        parameters = WRITE_PARAMETERS
        executionMode = None

        async def execute(
            self,
            tool_call_id: str,
            params: dict[str, Any],
            signal: Any = None,
            on_update: Any = None,
        ) -> AgentToolResult:
            return await execute_write(
                cwd,
                params["path"],
                params["content"],
                options=opts,
                signal=signal,
            )

    return WriteTool()  # type: ignore[return-value]
