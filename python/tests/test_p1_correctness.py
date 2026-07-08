"""P1 correctness fixes: skill expansion, RPC abort/clone, bash accumulator, compaction, exec."""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any
from unittest.mock import AsyncMock

import pytest

from pi_mono.agent.harness.types import Skill
from pi_mono.agent.agent import Agent
from pi_mono.ai.providers.faux import register_faux_provider
from pi_mono.coding_agent.core.agent_session import AgentSession, AgentSessionConfig, PromptOptions
from pi_mono.coding_agent.core.exec import exec_command
from pi_mono.coding_agent.core.extensions.loader import (
    create_extension_runtime,
    load_extension_from_factory,
)
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
)
from pi_mono.coding_agent.core.skills import expand_skill_command
from pi_mono.coding_agent.core.tools.bash import execute_bash
from pi_mono.coding_agent.core.tools.output_accumulator import OutputAccumulator
from pi_mono.coding_agent.core.tools.truncate import DEFAULT_MAX_BYTES
from pi_mono.coding_agent.modes.rpc.rpc_mode import RpcMode, parse_rpc_command
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.event_bus import create_event_bus
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


@pytest.fixture
def minimal_session_with_skill(tmp_path):
    cwd = str(tmp_path)
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    model = faux.get_model()
    assert model is not None
    auth_storage = AuthStorage.create()
    auth_storage.set_runtime_api_key("faux", "faux-key")
    model_registry = ModelRegistry.in_memory(auth_storage)
    model_registry.register_provider(
        "faux",
        {
            "baseUrl": model["baseUrl"],
            "apiKey": "faux-key",
            "api": faux.api,
            "models": [
                {
                    "id": model["id"],
                    "name": model["name"],
                    "api": model["api"],
                    "reasoning": model.get("reasoning", False),
                    "input": model.get("input", ["text"]),
                    "cost": model.get("cost"),
                    "contextWindow": model.get("contextWindow", 128000),
                    "maxTokens": model.get("maxTokens", 16384),
                    "baseUrl": model["baseUrl"],
                }
            ],
        },
    )
    settings_manager = SettingsManager.in_memory()
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd, agent_dir=str(tmp_path / "agent"), settings_manager=settings_manager
        )
    )
    resource_loader._skills = [  # type: ignore[attr-defined]
        Skill(name="deploy", description="", content="DEPLOY_BODY", file_path="/x/SKILL.md")
    ]
    agent = Agent(
        {"getApiKey": lambda *_a: "faux-key", "initialState": {"model": model, "tools": []}}
    )
    return AgentSession(
        AgentSessionConfig(
            agent=agent,
            session_manager=SessionManager.in_memory(cwd),
            settings_manager=settings_manager,
            cwd=cwd,
            model_registry=model_registry,
            resource_loader=resource_loader,
        )
    )


def test_expand_skill_command_replaces_skill_invocation() -> None:
    skill = Skill(
        name="deploy",
        description="Deploy app",
        content="Run deploy steps here.",
        file_path="/tmp/skills/deploy/SKILL.md",
    )
    expanded = expand_skill_command("/skill:deploy extra context", [skill])
    assert '<skill name="deploy"' in expanded
    assert "Run deploy steps here." in expanded
    assert expanded.endswith("extra context")


def test_expand_skill_command_passes_through_unknown_skill() -> None:
    assert expand_skill_command("/skill:missing", []) == "/skill:missing"


@pytest.mark.anyio
async def test_prompt_expands_skill_before_sending(minimal_session_with_skill) -> None:
    session = minimal_session_with_skill
    captured: list[Any] = []

    async def capture_run(messages: Any) -> None:
        captured.append(messages)

    session._run_agent_prompt = capture_run  # type: ignore[method-assign]
    await session.prompt("/skill:deploy", PromptOptions(preflight_result=lambda _s: None))
    assert captured
    text = captured[0][0]["content"][0]["text"]
    assert "DEPLOY_BODY" in text
    assert "/skill:deploy" not in text


@pytest.mark.anyio
async def test_steer_expands_skill_command(minimal_session_with_skill) -> None:
    session = minimal_session_with_skill
    await session.steer("/skill:deploy follow-up")
    assert session.get_steering_messages()
    assert "DEPLOY_BODY" in session.get_steering_messages()[-1]


@pytest.mark.anyio
async def test_rpc_abort_awaits_session_abort(tmp_path) -> None:
    from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
    from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    abort_called = asyncio.Event()

    async def spy_abort() -> None:
        abort_called.set()
        await asyncio.sleep(0.05)

    result.session.abort = spy_abort  # type: ignore[method-assign]

    response = await mode.handle_command(parse_rpc_command('{"type":"abort","id":"a1"}'))
    assert response is not None and response["success"] is True
    assert abort_called.is_set()


@pytest.mark.anyio
async def test_rpc_clone_errors_without_leaf(tmp_path) -> None:
    from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
    from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    result.session.session_manager.leafId = None

    response = await mode.handle_command(parse_rpc_command('{"type":"clone","id":"c1"}'))
    assert response is not None and response["success"] is False
    assert "no current entry" in str(response.get("error", "")).lower()


@pytest.mark.anyio
async def test_rpc_clone_returns_cancelled_only(tmp_path) -> None:
    from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
    from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    result.session.session_manager.leafId = "leaf-1"

    async def fake_fork(_entry_id: str, _options: dict[str, Any] | None = None) -> dict[str, Any]:
        return {"cancelled": False, "selectedText": "ignored"}

    runtime.fork = fake_fork  # type: ignore[method-assign]

    response = await mode.handle_command(parse_rpc_command('{"type":"clone","id":"c2"}'))
    assert response is not None and response["success"] is True
    assert response["data"] == {"cancelled": False}


def test_output_accumulator_persists_full_output_when_truncated() -> None:
    accumulator = OutputAccumulator(temp_file_prefix="pi-bash-test")
    payload = ("line\n" * 5000).encode("utf-8")
    accumulator.append(payload)
    accumulator.finish()
    snapshot = accumulator.snapshot(persist_if_truncated=True)
    assert snapshot.truncation["truncated"] is True
    assert snapshot.fullOutputPath
    assert os.path.exists(snapshot.fullOutputPath)
    with open(snapshot.fullOutputPath, encoding="utf-8") as handle:
        full = handle.read()
    assert full.count("line") == 5000


@pytest.mark.anyio
async def test_bash_tool_sets_full_output_path_when_truncated(tmp_path) -> None:
    line_count = (DEFAULT_MAX_BYTES // 8) + 50
    command = (
        f"{sys.executable} -c "
        f"\"import sys; sys.stdout.write(('x'*80 + chr(10)) * {line_count})\""
    )
    result = await execute_bash(str(tmp_path), command)
    details = result.get("details") or {}
    assert details.get("truncation", {}).get("truncated") is True
    assert details.get("fullOutputPath")
    assert os.path.exists(str(details["fullOutputPath"]))


def test_find_last_assistant_message(minimal_session_with_skill) -> None:
    session = minimal_session_with_skill
    session.agent.state.messages = [
        {"role": "user", "content": [{"type": "text", "text": "hi"}]},
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "partial"}],
            "stopReason": "aborted",
            "api": "faux",
            "provider": "faux",
            "model": "faux-1",
            "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 2,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            },
            "timestamp": 1,
        },
    ]
    last = session._find_last_assistant_message()
    assert last is not None
    assert last.get("stopReason") == "aborted"


@pytest.mark.anyio
async def test_prompt_runs_pre_prompt_compaction_check(minimal_session_with_skill) -> None:
    session = minimal_session_with_skill
    session._check_compaction = AsyncMock(return_value=False)  # type: ignore[method-assign]
    session.agent.state.messages.append(
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "aborted"}],
            "stopReason": "aborted",
            "api": "faux",
            "provider": "faux",
            "model": "faux-1",
            "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 2,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            },
            "timestamp": 1,
        }
    )
    session._run_agent_prompt = AsyncMock()  # type: ignore[method-assign]
    await session.prompt("next", PromptOptions(preflight_result=lambda _s: None))
    session._check_compaction.assert_awaited()
    assert session._check_compaction.await_args.kwargs.get("skip_aborted_check") is False


@pytest.mark.anyio
async def test_exec_command_runs_process(tmp_path) -> None:
    result = await exec_command(sys.executable, ["-c", "print('exec-ok')"], str(tmp_path))
    assert result["code"] == 0
    assert "exec-ok" in result["stdout"]


@pytest.mark.anyio
async def test_extension_api_exec(tmp_path) -> None:
    captured: list[str] = []

    def factory(api: Any) -> None:
        async def handler(_args: str, _ctx: Any) -> None:
            result = await api.exec(sys.executable, ["-c", "print('from-extension')"])
            captured.append(result["stdout"])

        api.register_command("run-exec", {"handler": handler})

    runtime = create_extension_runtime()
    event_bus = create_event_bus()
    extension = await load_extension_from_factory(
        factory,
        str(tmp_path),
        event_bus,
        runtime,
        extension_path="<inline-exec-test>",
    )
    await extension.commands["run-exec"].handler("", None)  # type: ignore[arg-type]
    assert captured
    assert "from-extension" in captured[0]
