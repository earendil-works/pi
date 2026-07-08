"""Tool definition wrapper tests."""

from __future__ import annotations

from typing import Any

import pytest

from pi_mono.coding_agent.core.extensions.types import ToolDefinition
from pi_mono.coding_agent.core.tools.read import ReadToolOptions, create_read_tool
from pi_mono.coding_agent.core.tools.read_tool_definition import (
    create_read_tool_definition,
    create_read_tool_from_definition,
)
from pi_mono.coding_agent.core.tools.tool_definition_wrapper import (
    create_tool_definition_from_agent_tool,
    wrap_tool_definition,
    wrap_tool_definitions,
)


@pytest.mark.anyio
async def test_wrap_tool_definition_passes_extension_context() -> None:
    seen: list[Any] = []

    async def execute(
        _tool_call_id: str,
        _params: Any,
        _signal: Any = None,
        _on_update: Any = None,
        ctx: Any = None,
    ) -> dict[str, Any]:
        seen.append(ctx)
        return {"content": [{"type": "text", "text": "ok"}], "details": None}

    definition = ToolDefinition(
        name="echo",
        label="echo",
        description="echo",
        parameters={"type": "object", "properties": {}},
        execute=execute,
    )
    tool = wrap_tool_definition(definition, lambda: {"marker": True})
    result = await tool.execute("call-1", {})
    assert result["content"][0]["text"] == "ok"
    assert seen == [{"marker": True}]


def test_wrap_tool_definitions_maps_all_definitions() -> None:
    definitions = [
        ToolDefinition(
            name="a",
            label="a",
            description="a",
            parameters={"type": "object", "properties": {}},
            execute=lambda *_a, **_k: None,  # type: ignore[arg-type, return-value]
        ),
        ToolDefinition(
            name="b",
            label="b",
            description="b",
            parameters={"type": "object", "properties": {}},
            execute=lambda *_a, **_k: None,  # type: ignore[arg-type, return-value]
        ),
    ]
    tools = wrap_tool_definitions(definitions)
    assert [tool.name for tool in tools] == ["a", "b"]


@pytest.mark.anyio
async def test_create_tool_definition_from_agent_tool_round_trips_execute() -> None:
    class EchoTool:
        name = "echo"
        label = "echo"
        description = "echo"
        parameters = {"type": "object", "properties": {}}

        async def execute(
            self, _tool_call_id: str, _params: Any, _signal: Any = None, _on_update: Any = None
        ):
            return {"content": [{"type": "text", "text": "wrapped"}], "details": None}

    definition = create_tool_definition_from_agent_tool(EchoTool())  # type: ignore[arg-type]
    result = await definition.execute("call-1", {})
    assert result["content"][0]["text"] == "wrapped"


def test_create_read_tool_definition_and_tool_share_name() -> None:
    definition = create_read_tool_definition("/tmp")
    tool = create_read_tool_from_definition("/tmp", ReadToolOptions())
    runtime_tool = create_read_tool("/tmp", ReadToolOptions())
    assert definition.name == "read"
    assert tool.name == "read"
    assert runtime_tool.name == "read"
    assert definition.prompt_snippet is not None
