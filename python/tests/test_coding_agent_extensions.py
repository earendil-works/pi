"""Smoke tests for coding agent extension loader and runner."""

from __future__ import annotations

import asyncio
import os

import pytest

from pi_mono.coding_agent.core.extensions import (
    ExtensionRunner,
    create_extension_runtime,
    discover_extensions_in_dir,
    load_extension_from_factory,
)
from pi_mono.coding_agent.core.extensions.loader import (
    create_extension_runtime as loader_create_runtime,
)
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.event_bus import create_event_bus
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager


def test_load_extension_from_factory_registers_handler(tmp_path):
    seen: list[str] = []

    def factory(pi):
        def on_session_start(_event, _ctx):
            seen.append("started")

        pi.on("session_start", on_session_start)

    async def run() -> None:
        runtime = create_extension_runtime()
        extension = await load_extension_from_factory(
            factory,
            str(tmp_path),
            create_event_bus(),
            runtime,
            "<inline-test>",
        )
        assert extension.path == "<inline-test>"
        assert "session_start" in extension.handlers
        assert len(extension.handlers["session_start"]) == 1

    asyncio.run(run())


def test_discover_extensions_in_dir_finds_python_files(tmp_path):
    ext_dir = tmp_path / "extensions"
    ext_dir.mkdir()
    ext_file = ext_dir / "demo.py"
    ext_file.write_text("def default(pi):\n    pass\n", encoding="utf-8")

    discovered = discover_extensions_in_dir(str(ext_dir))
    assert discovered == [str(ext_file)]


def test_extension_runner_noop_emit_without_handlers():
    async def run() -> None:
        runtime = loader_create_runtime()
        session_manager = SessionManager.in_memory(os.getcwd())
        model_registry = ModelRegistry.in_memory(AuthStorage.create())
        runner = ExtensionRunner([], runtime, os.getcwd(), session_manager, model_registry)

        assert runner.has_handlers("session_start") is False
        result = await runner.emit({"type": "session_start", "reason": "startup"})
        assert result is None

    asyncio.run(run())


def test_create_extension_runtime_rejects_action_calls():
    runtime = create_extension_runtime()
    with pytest.raises(RuntimeError, match="not initialized"):
        runtime.send_message({"customType": "test"})


def test_agent_session_bind_extensions_creates_runner(tmp_path):
    from pi_mono.agent.agent import Agent
    from pi_mono.coding_agent.core.agent_session import AgentSession, AgentSessionConfig
    from pi_mono.coding_agent.core.resource_loader import (
        DefaultResourceLoader,
        DefaultResourceLoaderOptions,
    )
    from pi_mono.core.settings_manager import SettingsManager

    async def run() -> None:
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
                "systemPrompt": "test",
                "model": {
                    "id": "unknown",
                    "name": "unknown",
                    "api": "unknown",
                    "provider": "unknown",
                    "baseUrl": "",
                    "reasoning": False,
                    "input": ["text"],
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": 128000,
                    "maxTokens": 16384,
                },
                "thinkingLevel": "off",
                "tools": [],
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
                no_extensions=True,
            )
        )
        await session.bind_extensions()
        assert session.extension_runner is not None
        assert session.extension_runner.get_extension_paths() == []

    asyncio.run(run())
