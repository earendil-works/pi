"""Regression #3592: noTools=builtin keeps extension tools while disabling built-in defaults."""

from __future__ import annotations

import textwrap

import pytest

from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
)
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _write_dynamic_tool_extension(tmp_path) -> str:
    ext_dir = tmp_path / ".pi" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    source = textwrap.dedent(
        """
        from pi_mono.coding_agent.core.extensions.types import ToolDefinition

        async def execute_ok(tool_call_id, params, signal=None, on_update=None):
            return {"content": [{"type": "text", "text": "ok"}], "details": {}}

        async def on_session_start(event, ctx):
            pi.register_tool(
                ToolDefinition(
                    name="dynamic_tool",
                    label="Dynamic Tool",
                    description="Tool registered from session_start",
                    parameters={"type": "object", "properties": {}},
                    execute=execute_ok,
                    prompt_snippet="Run dynamic test behavior",
                )
            )

        pi.on("session_start", on_session_start)
        """
    ).strip("\n")
    (ext_dir / "dynamic.py").write_text(
        "async def default(pi):\n" + textwrap.indent(source, "    ") + "\n",
        encoding="utf-8",
    )
    return str(ext_dir)


@pytest.mark.anyio
async def test_no_builtin_tools_keeps_extension_tools_active(tmp_path) -> None:
    _write_dynamic_tool_extension(tmp_path)
    cwd = str(tmp_path)
    agent_dir = str(tmp_path / "agent")
    settings_manager = SettingsManager.create(cwd, agent_dir)
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd,
            agent_dir=agent_dir,
            settings_manager=settings_manager,
        )
    )
    await resource_loader.reload()

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=cwd,
            agent_dir=agent_dir,
            settings_manager=settings_manager,
            resource_loader=resource_loader,
            session_manager=SessionManager.in_memory(cwd),
            no_tools="builtin",
        )
    )
    session = result.session
    await session.bind_extensions()

    tool_names = sorted(tool["name"] for tool in session.get_all_tools())
    assert tool_names == ["bash", "dynamic_tool", "edit", "find", "grep", "ls", "read", "write"]
    assert session.get_active_tool_names() == ["dynamic_tool"]
    assert "dynamic_tool: Run dynamic test behavior" in session.system_prompt
    assert "- read:" not in session.system_prompt
    assert "- bash:" not in session.system_prompt


@pytest.mark.anyio
async def test_no_tools_all_disables_everything(tmp_path) -> None:
    _write_dynamic_tool_extension(tmp_path)
    cwd = str(tmp_path)
    agent_dir = str(tmp_path / "agent")
    settings_manager = SettingsManager.create(cwd, agent_dir)
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd,
            agent_dir=agent_dir,
            settings_manager=settings_manager,
        )
    )
    await resource_loader.reload()

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=cwd,
            agent_dir=agent_dir,
            settings_manager=settings_manager,
            resource_loader=resource_loader,
            session_manager=SessionManager.in_memory(cwd),
            no_tools="all",
        )
    )
    session = result.session
    await session.bind_extensions()

    assert session.get_all_tools() == []
    assert session.get_active_tool_names() == []
    assert "Available tools:\n(none)" in session.system_prompt
