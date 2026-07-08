"""RPC prompt preflight semantics (ported from rpc-prompt-response-semantics.test.ts)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from pi_mono.agent.harness.types import PromptTemplate, Skill
from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
)
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.coding_agent.modes.rpc.rpc_mode import RpcMode, parse_rpc_command


def _parse_output_lines(lines: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in lines:
        for part in line.split("\n"):
            stripped = part.strip()
            if stripped:
                records.append(json.loads(stripped))
    return records


def _prompt_responses(lines: list[str], command_id: str) -> list[dict[str, Any]]:
    return [
        record
        for record in _parse_output_lines(lines)
        if record.get("id") == command_id
        and record.get("type") == "response"
        and record.get("command") == "prompt"
    ]


async def _make_rpc_mode_with_faux(
    tmp_path: Any,
    *,
    with_configured_auth: bool = True,
) -> tuple[RpcMode, AgentSessionRuntime]:
    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)

    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    initial_model = faux.get_model()
    assert initial_model is not None
    faux.set_responses([faux_assistant_message("done")])

    auth_storage = AuthStorage.create()
    if with_configured_auth:
        auth_storage.set_runtime_api_key("faux", "faux-key")

    model_registry = ModelRegistry.in_memory(auth_storage)
    if with_configured_auth:
        model_registry.register_provider(
            "faux",
            {
                "baseUrl": initial_model["baseUrl"],
                "apiKey": "faux-key",
                "api": faux.api,
                "models": [
                    {
                        "id": registered_model["id"],
                        "name": registered_model["name"],
                        "api": registered_model["api"],
                        "reasoning": registered_model.get("reasoning", False),
                        "input": registered_model.get("input", ["text"]),
                        "cost": registered_model.get("cost"),
                        "contextWindow": registered_model.get("contextWindow", 128000),
                        "maxTokens": registered_model.get("maxTokens", 16384),
                        "baseUrl": registered_model["baseUrl"],
                    }
                    for registered_model in faux.models
                ],
            },
        )

    settings_manager = SettingsManager.in_memory()
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd, agent_dir=str(agent_dir), settings_manager=settings_manager
        )
    )
    await resource_loader.reload()

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=cwd,
            agent_dir=str(agent_dir),
            auth_storage=auth_storage,
            model_registry=model_registry,
            settings_manager=settings_manager,
            resource_loader=resource_loader,
            session_manager=SessionManager.in_memory(cwd),
            model=initial_model,
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    mode = RpcMode(runtime)
    await mode._rebind_session()
    return mode, runtime


@pytest.mark.anyio
async def test_prompt_preflight_failure_emits_one_error_response(tmp_path, monkeypatch) -> None:
    mode, _runtime = await _make_rpc_mode_with_faux(tmp_path, with_configured_auth=False)
    output_lines: list[str] = []
    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.rpc.rpc_mode.write_raw_stdout",
        lambda line: output_lines.append(line),
    )

    await mode.handle_command(
        parse_rpc_command(json.dumps({"id": "b1", "type": "prompt", "message": "Hello"}))
    )
    for _ in range(50):
        if _prompt_responses(output_lines, "b1"):
            break
        await asyncio.sleep(0.01)

    responses = _prompt_responses(output_lines, "b1")
    assert len(responses) == 1
    assert responses[0]["success"] is False
    assert "No API key found" in str(responses[0].get("error", ""))


@pytest.mark.anyio
async def test_prompt_preflight_success_emits_one_success_response(tmp_path, monkeypatch) -> None:
    mode, _runtime = await _make_rpc_mode_with_faux(tmp_path, with_configured_auth=True)
    output_lines: list[str] = []
    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.rpc.rpc_mode.write_raw_stdout",
        lambda line: output_lines.append(line),
    )

    await mode.handle_command(
        parse_rpc_command(json.dumps({"id": "b2", "type": "prompt", "message": "Hello"}))
    )
    for _ in range(50):
        if _prompt_responses(output_lines, "b2"):
            break
        await asyncio.sleep(0.01)

    responses = _prompt_responses(output_lines, "b2")
    assert len(responses) == 1
    assert responses[0]["success"] is True


@pytest.mark.anyio
async def test_prompt_preflight_success_before_agent_run_completes(tmp_path, monkeypatch) -> None:
    mode, runtime = await _make_rpc_mode_with_faux(tmp_path, with_configured_auth=True)
    output_lines: list[str] = []
    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.rpc.rpc_mode.write_raw_stdout",
        lambda line: output_lines.append(line),
    )

    release_run = asyncio.Event()

    async def slow_run(_messages: Any) -> None:
        await release_run.wait()

    runtime.session._run_agent_prompt = slow_run  # type: ignore[method-assign]

    await mode.handle_command(
        parse_rpc_command(json.dumps({"id": "b2b", "type": "prompt", "message": "Hello"}))
    )
    for _ in range(50):
        if _prompt_responses(output_lines, "b2b"):
            break
        await asyncio.sleep(0.01)

    assert len(_prompt_responses(output_lines, "b2b")) == 1
    assert _prompt_responses(output_lines, "b2b")[0]["success"] is True
    assert runtime.session.is_streaming is False
    release_run.set()


@pytest.mark.anyio
async def test_prompt_queued_during_streaming_emits_immediate_success(
    tmp_path, monkeypatch
) -> None:
    mode, runtime = await _make_rpc_mode_with_faux(tmp_path, with_configured_auth=True)
    output_lines: list[str] = []
    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.rpc.rpc_mode.write_raw_stdout",
        lambda line: output_lines.append(line),
    )

    hold_first_run = asyncio.Event()
    release_first_run = asyncio.Event()

    async def holding_run(messages: Any) -> None:
        runtime.session.agent.state._is_streaming = True
        hold_first_run.set()
        await release_first_run.wait()
        runtime.session.agent.state._is_streaming = False

    runtime.session._run_agent_prompt = holding_run  # type: ignore[method-assign]

    await mode.handle_command(
        parse_rpc_command(json.dumps({"id": "b3-start", "type": "prompt", "message": "Start"}))
    )
    for _ in range(100):
        if hold_first_run.is_set() and _prompt_responses(output_lines, "b3-start"):
            break
        await asyncio.sleep(0.01)
    assert runtime.session.is_streaming is True

    output_lines.clear()
    await mode.handle_command(
        parse_rpc_command(
            json.dumps(
                {
                    "id": "b3",
                    "type": "prompt",
                    "message": "Queue this",
                    "streamingBehavior": "followUp",
                }
            )
        )
    )
    for _ in range(50):
        if _prompt_responses(output_lines, "b3"):
            break
        await asyncio.sleep(0.01)

    responses = _prompt_responses(output_lines, "b3")
    assert len(responses) == 1
    assert responses[0]["success"] is True

    release_first_run.set()
    await runtime.session.abort()


@pytest.mark.anyio
async def test_rpc_get_commands_lists_extensions_prompts_and_skills(tmp_path) -> None:
    mode, runtime = await _make_rpc_mode_with_faux(tmp_path)
    session = runtime.session
    session._resource_loader._prompts = [  # type: ignore[attr-defined]
        PromptTemplate(name="review", description="Review code", content="Review $1")
    ]
    session._resource_loader._skills = [  # type: ignore[attr-defined]
        Skill(
            name="deploy",
            description="Deploy the app",
            content="Deploy steps",
            file_path=str(tmp_path / "skills" / "deploy" / "SKILL.md"),
        )
    ]

    response = await mode.handle_command(parse_rpc_command('{"type":"get_commands","id":"gc1"}'))
    assert response is not None and response["success"] is True
    commands = response["data"]["commands"]
    by_name = {item["name"]: item for item in commands}

    assert "review" in by_name and by_name["review"]["source"] == "prompt"
    assert "skill:deploy" in by_name and by_name["skill:deploy"]["source"] == "skill"
    assert "model" not in by_name
    assert "quit" not in by_name


@pytest.mark.anyio
async def test_rpc_new_session_passes_parent_session(tmp_path) -> None:
    mode, runtime = await _make_rpc_mode_with_faux(tmp_path)
    captured: list[dict[str, Any] | None] = []

    async def spy_new_session(options: dict[str, Any] | None = None) -> dict[str, bool]:
        captured.append(options)
        return {"cancelled": True}

    runtime.new_session = spy_new_session  # type: ignore[method-assign]

    response = await mode.handle_command(
        parse_rpc_command(
            json.dumps(
                {
                    "type": "new_session",
                    "id": "ns1",
                    "parentSession": "/tmp/parent.jsonl",
                }
            )
        )
    )
    assert response is not None and response["success"] is True
    assert captured == [{"parentSession": "/tmp/parent.jsonl"}]
