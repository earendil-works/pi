"""Regression helpers for tool filtering tests."""

from __future__ import annotations

import os
import textwrap
from typing import Any

from pi_mono.agent.agent import Agent
from pi_mono.coding_agent.core.agent_session import AgentSession, AgentSessionConfig
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
)
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _model() -> dict[str, Any]:
    return {
        "id": "claude-sonnet-4-5",
        "name": "claude-sonnet-4-5",
        "api": "anthropic-messages",
        "provider": "anthropic",
        "baseUrl": "https://example.com",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128000,
        "maxTokens": 16384,
    }


def write_tool_extension(tmp_path: Any) -> str:
    ext_dir = tmp_path / "extensions"
    ext_dir.mkdir(exist_ok=True)
    ext_file = ext_dir / "tools.py"
    source = textwrap.dedent(
        """
        from pi_mono.coding_agent.core.extensions.types import ToolDefinition

        async def execute_ok(tool_call_id, params, signal=None, on_update=None):
            return {"content": [{"type": "text", "text": "ok"}], "details": {}}

        async def on_session_start(event, ctx):
            pi.register_tool(
                ToolDefinition(
                    name="ask_question",
                    label="Ask Question",
                    description="Ask a question",
                    parameters={"type": "object", "properties": {}},
                    execute=execute_ok,
                    prompt_snippet="Ask a question",
                )
            )
            pi.register_tool(
                ToolDefinition(
                    name="dynamic_tool",
                    label="Dynamic Tool",
                    description="Dynamic test tool",
                    parameters={"type": "object", "properties": {}},
                    execute=execute_ok,
                    prompt_snippet="Run dynamic test behavior",
                )
            )

        pi.on("session_start", on_session_start)
        """
    ).strip("\n")
    ext_file.write_text(
        "async def default(pi):\n" + textwrap.indent(source, "    ") + "\n", encoding="utf-8"
    )
    return str(ext_dir)


def write_dynamic_tool_extension(tmp_path: Any) -> str:
    ext_dir = tmp_path / "extensions"
    ext_dir.mkdir(exist_ok=True)
    ext_file = ext_dir / "dynamic.py"
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
    ext_file.write_text(
        "async def default(pi):\n" + textwrap.indent(source, "    ") + "\n", encoding="utf-8"
    )
    return str(ext_dir)


async def make_tool_session(
    tmp_path: Any,
    *,
    extension_paths: list[str],
    allowed_tool_names: list[str] | None = None,
    excluded_tool_names: list[str] | None = None,
    initial_active_tool_names: list[str] | None = None,
) -> AgentSession:
    cwd = str(tmp_path)
    agent_dir = str(tmp_path / "agent")
    os.makedirs(agent_dir, exist_ok=True)
    settings_manager = SettingsManager.create(cwd, agent_dir)
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd, agent_dir=agent_dir, settings_manager=settings_manager
        )
    )
    await resource_loader.reload()
    agent = Agent(
        {
            "initialState": {
                "systemPrompt": "test",
                "model": _model(),
                "thinkingLevel": "off",
                "tools": [],
            }
        }
    )
    session = AgentSession(
        AgentSessionConfig(
            agent=agent,
            session_manager=SessionManager.in_memory(cwd),
            settings_manager=settings_manager,
            cwd=cwd,
            model_registry=ModelRegistry.in_memory(AuthStorage.create()),
            resource_loader=resource_loader,
            extension_paths=extension_paths,
            allowed_tool_names=allowed_tool_names,
            excluded_tool_names=excluded_tool_names,
            initial_active_tool_names=initial_active_tool_names,
        )
    )
    await session.bind_extensions()
    return session
