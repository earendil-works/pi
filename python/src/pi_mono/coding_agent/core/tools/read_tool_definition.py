"""Read tool definition factory for extensions."""

from __future__ import annotations

from typing import Any

from pi_mono.agent.types import AgentTool, AgentToolResult
from pi_mono.coding_agent.core.extensions.types import ToolDefinition
from pi_mono.coding_agent.core.tools.read import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    READ_PARAMETERS,
    ReadToolOptions,
    execute_read,
)
from pi_mono.coding_agent.core.tools.tool_definition_wrapper import wrap_tool_definition


def create_read_tool_definition(cwd: str, options: ReadToolOptions | None = None) -> ToolDefinition:
    opts = options or ReadToolOptions()

    async def execute(
        _tool_call_id: str,
        params: dict[str, Any],
        signal: Any = None,
        _on_update: Any = None,
        ctx: Any = None,
    ) -> AgentToolResult:
        if signal is not None and getattr(signal, "aborted", False):
            raise RuntimeError("Operation aborted")
        model = getattr(ctx, "model", None) if ctx is not None else None
        return await execute_read(
            cwd,
            params["path"],
            params.get("offset"),
            params.get("limit"),
            options=opts,
            model=model,
        )

    return ToolDefinition(
        name="read",
        label="read",
        description=(
            f"Read the contents of a file. Supports text files and images "
            f"(jpg, png, gif, webp). Images are sent as attachments. For text files, "
            f"output is truncated to {DEFAULT_MAX_LINES} lines or "
            f"{DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first). Use offset/limit "
            f"for large files."
        ),
        parameters=READ_PARAMETERS,
        execute=execute,
        prompt_snippet="Read file contents",
        prompt_guidelines=["Use read to examine files instead of cat or sed."],
    )


def create_read_tool_from_definition(cwd: str, options: ReadToolOptions | None = None) -> AgentTool:
    return wrap_tool_definition(create_read_tool_definition(cwd, options))
