"""Wrap ToolDefinitions as AgentTools and synthesize definitions from tools."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pi_mono.agent.types import AgentTool, AgentToolResult, AgentToolUpdateCallback
from pi_mono.coding_agent.core.extensions.types import ToolDefinition
from pi_mono.utils.abort_signals import AbortSignal


def wrap_tool_definition(
    definition: ToolDefinition,
    ctx_factory: Callable[[], Any] | None = None,
) -> AgentTool:
    class _WrappedTool:
        name = definition.name
        label = definition.label
        description = definition.description
        parameters = definition.parameters
        executionMode = None

        async def execute(
            self,
            tool_call_id: str,
            params: Any,
            signal: AbortSignal | None = None,
            on_update: AgentToolUpdateCallback | None = None,
        ) -> AgentToolResult:
            ctx = ctx_factory() if ctx_factory else None
            return await definition.execute(tool_call_id, params, signal, on_update, ctx)

    return _WrappedTool()  # type: ignore[return-value]


def wrap_tool_definitions(
    definitions: list[ToolDefinition],
    ctx_factory: Callable[[], Any] | None = None,
) -> list[AgentTool]:
    return [wrap_tool_definition(definition, ctx_factory) for definition in definitions]


def create_tool_definition_from_agent_tool(tool: AgentTool) -> ToolDefinition:
    async def execute(
        tool_call_id: str,
        params: Any,
        signal: AbortSignal | None = None,
        on_update: AgentToolUpdateCallback | None = None,
        _ctx: Any = None,
    ) -> AgentToolResult:
        return await tool.execute(tool_call_id, params, signal, on_update)

    return ToolDefinition(
        name=tool.name,
        label=tool.label,
        description=tool.description,
        parameters=tool.parameters,
        execute=execute,
    )
