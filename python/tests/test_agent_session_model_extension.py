"""AgentSession model/thinking extension observability tests (Phase 4)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from pi_mono.ai.providers.faux import register_faux_provider
from pi_mono.coding_agent.core.agent_session import AgentSession
from pi_mono.coding_agent.core.extensions import (
    ExtensionRunner,
    LoadExtensionsResult,
    create_extension_runtime,
)
from pi_mono.coding_agent.core.extensions.types import Extension
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
)
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.coding_agent.core.source_info import SourceInfo
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _make_extension(
    handlers: dict[str, list[Any]],
    *,
    path: str = "/test/model-extension.py",
) -> Extension:
    return Extension(
        path=path,
        resolved_path=path,
        source_info=SourceInfo(
            path=path,
            source=path,
            scope="project",
            origin="top-level",
        ),
        handlers=handlers,
    )


async def _flush_extension_events() -> None:
    await asyncio.sleep(0)


async def _create_session(
    tmp_path: Any,
    *,
    models: list[dict[str, Any]],
    with_configured_auth: bool = True,
    extension_handlers: dict[str, list[Any]] | None = None,
) -> tuple[AgentSession, Any]:
    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)

    faux = register_faux_provider({"provider": "faux", "api": "faux", "models": models})
    initial_model = faux.get_model()
    assert initial_model is not None

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
            session_manager=SessionManager.in_memory(cwd),
            model=initial_model,
            resource_loader=resource_loader,
            no_tools="all",
            no_extensions=True,
        )
    )
    session = result.session

    if extension_handlers is not None:
        extension = _make_extension(extension_handlers)
        runtime = create_extension_runtime()
        session._extension_runner = ExtensionRunner(
            [extension],
            runtime,
            cwd,
            session.session_manager,
            model_registry,
        )
        session._extension_load_result = LoadExtensionsResult(
            extensions=[extension], errors=[], runtime=runtime
        )
        await session.bind_extensions()

    return session, faux


@pytest.mark.anyio
async def test_set_model_saves_model_and_emits_model_select(tmp_path: Any) -> None:
    model_events: list[str] = []

    async def on_model_select(event: dict[str, Any], _ctx: Any) -> None:
        previous = event.get("previousModel")
        previous_id = previous["id"] if previous else "none"
        model = event["model"]
        model_events.append(f"{previous_id}->{model['id']}:{event['source']}")

    session, faux = await _create_session(
        tmp_path,
        models=[
            {"id": "faux-1", "name": "One", "reasoning": True},
            {"id": "faux-2", "name": "Two", "reasoning": True},
        ],
        extension_handlers={"model_select": [on_model_select]},
    )
    try:
        next_model = faux.get_model("faux-2")
        assert next_model is not None

        await session.set_model(next_model)

        assert session.model is not None
        assert session.model["id"] == "faux-2"
        assert model_events == ["faux-1->faux-2:set"]
        model_changes = [
            f"{entry['provider']}/{entry['modelId']}"
            for entry in session.session_manager.get_entries()
            if entry.get("type") == "model_change"
        ]
        assert model_changes[-1] == f"{next_model['provider']}/{next_model['id']}"
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_cycle_scoped_models_preserves_scoped_thinking_preference(tmp_path: Any) -> None:
    session, faux = await _create_session(
        tmp_path,
        models=[
            {"id": "faux-1", "name": "One", "reasoning": True},
            {"id": "faux-2", "name": "Two", "reasoning": False},
        ],
    )
    try:
        model_one = faux.get_model("faux-1")
        model_two = faux.get_model("faux-2")
        assert model_one is not None and model_two is not None

        session.set_scoped_models(
            [
                {"model": model_one, "thinkingLevel": "high"},
                {"model": model_two},
            ]
        )
        session.set_thinking_level("high")

        await session.cycle_model()
        assert session.model is not None
        assert session.model["id"] == "faux-2"
        assert session.thinking_level == "off"

        await session.cycle_model()
        assert session.model is not None
        assert session.model["id"] == "faux-1"
        assert session.thinking_level == "high"
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_clamps_thinking_levels_and_cycle_thinking_level_returns_none(tmp_path: Any) -> None:
    session, faux = await _create_session(
        tmp_path,
        models=[{"id": "faux-1", "reasoning": False}],
    )
    try:
        session.set_thinking_level("high")
        assert session.thinking_level == "off"
        assert session.cycle_thinking_level() is None
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_set_model_raises_without_configured_auth(tmp_path: Any) -> None:
    session, faux = await _create_session(
        tmp_path,
        models=[
            {"id": "faux-1", "name": "One", "reasoning": True},
            {"id": "faux-2", "name": "Two", "reasoning": True},
        ],
        with_configured_auth=False,
    )
    try:
        next_model = faux.get_model("faux-2")
        assert next_model is not None

        with pytest.raises(RuntimeError, match=f"No API key for {next_model['provider']}/faux-2"):
            await session.set_model(next_model)
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_thinking_level_select_on_model_switch_clamp(tmp_path: Any) -> None:
    thinking_events: list[str] = []

    async def on_thinking_level_select(event: dict[str, Any], _ctx: Any) -> None:
        thinking_events.append(f"{event['previousLevel']}->{event['level']}")

    session, faux = await _create_session(
        tmp_path,
        models=[
            {"id": "faux-1", "name": "One", "reasoning": True},
            {"id": "faux-2", "name": "Two", "reasoning": False},
        ],
        extension_handlers={"thinking_level_select": [on_thinking_level_select]},
    )
    try:
        model_one = faux.get_model("faux-1")
        model_two = faux.get_model("faux-2")
        assert model_one is not None and model_two is not None

        session.set_scoped_models(
            [
                {"model": model_one, "thinkingLevel": "high"},
                {"model": model_two},
            ]
        )
        session.set_thinking_level("high")
        await _flush_extension_events()
        thinking_events.clear()

        await session.cycle_model()
        await _flush_extension_events()

        assert session.model is not None
        assert session.model["id"] == "faux-2"
        assert session.thinking_level == "off"
        assert thinking_events == ["high->off"]
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_thinking_level_select_on_direct_level_change(tmp_path: Any) -> None:
    thinking_events: list[str] = []

    async def on_thinking_level_select(event: dict[str, Any], _ctx: Any) -> None:
        thinking_events.append(f"{event['previousLevel']}->{event['level']}")

    session, faux = await _create_session(
        tmp_path,
        models=[{"id": "faux-1", "name": "One", "reasoning": True}],
        extension_handlers={"thinking_level_select": [on_thinking_level_select]},
    )
    try:
        session.set_thinking_level("off")
        await _flush_extension_events()
        thinking_events.clear()

        session.set_thinking_level("high")
        await _flush_extension_events()

        assert session.thinking_level == "high"
        assert thinking_events == ["off->high"]
    finally:
        faux.unregister()
