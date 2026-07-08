"""Wrap extension ToolDefinitions as AgentTools for the agent runtime."""

from __future__ import annotations

from pi_mono.agent.types import AgentTool
from pi_mono.coding_agent.core.extensions.runner import ExtensionRunner
from pi_mono.coding_agent.core.extensions.types import RegisteredTool
from pi_mono.coding_agent.core.tools.tool_definition_wrapper import (
    wrap_tool_definition,
    wrap_tool_definitions,
)

__all__ = [
    "wrap_tool_definition",
    "wrap_tool_definitions",
    "wrap_registered_tool",
    "wrap_registered_tools",
]


def wrap_registered_tool(registered_tool: RegisteredTool, runner: ExtensionRunner) -> AgentTool:
    return wrap_tool_definition(registered_tool.definition, runner.create_context)


def wrap_registered_tools(
    registered_tools: list[RegisteredTool], runner: ExtensionRunner
) -> list[AgentTool]:
    return [
        wrap_tool_definition(registered.definition, runner.create_context)
        for registered in registered_tools
    ]
