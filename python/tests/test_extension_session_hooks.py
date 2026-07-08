"""Extension session lifecycle hook tests (Phase 1)."""

from __future__ import annotations

from typing import Any

import pytest

from pi_mono.agent.agent import Agent
from pi_mono.agent.harness.messages import create_user_message
from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.agent_session import (
    AgentSession,
    AgentSessionConfig,
    AgentSessionRuntime,
)
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


def _assistant_for_compaction(text: str) -> dict[str, Any]:
    return faux_assistant_message(f"{text} {'token ' * 2000}")


def _faux_model() -> Any:
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    faux.set_responses(
        [
            faux_assistant_message("one"),
            faux_assistant_message("two"),
            faux_assistant_message("three"),
        ]
    )
    return faux


def _make_extension(
    handlers: dict[str, list[Any]],
    *,
    path: str = "/test/lifecycle.py",
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


async def _create_runtime_host(
    tmp_path: Any,
    handlers: dict[str, list[Any]],
) -> tuple[AgentSessionRuntime, Any]:
    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)

    faux = _faux_model()
    model = faux.get_model()
    assert model is not None

    auth_storage = AuthStorage.create()
    auth_storage.set_runtime_api_key("faux", "test-key")
    model_registry = ModelRegistry.create(auth_storage)
    settings_manager = SettingsManager.create(cwd, str(agent_dir))

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
            session_manager=SessionManager.create(cwd, str(agent_dir / "sessions")),
            model=model,
            resource_loader=resource_loader,
            no_tools="all",
            no_extensions=True,
        )
    )
    session = result.session
    extension = _make_extension(handlers)
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

    async def recreate_runtime(
        *,
        cwd: str,
        agent_dir: str,
        session_manager: SessionManager,
        session_start_event: dict[str, Any] | None = None,
    ) -> tuple[AgentSession, Any, list[dict[str, str]], str | None]:
        next_settings = SettingsManager.create(
            cwd,
            agent_dir,
            project_trusted=settings_manager.is_project_trusted(),
        )
        next_resource_loader = DefaultResourceLoader(
            DefaultResourceLoaderOptions(
                cwd=cwd, agent_dir=agent_dir, settings_manager=next_settings
            )
        )
        await next_resource_loader.reload()
        next_result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=cwd,
                agent_dir=agent_dir,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=next_settings,
                session_manager=session_manager,
                model=model,
                resource_loader=next_resource_loader,
                no_tools="all",
                no_extensions=True,
            )
        )
        next_session = next_result.session
        next_session._extension_runner = ExtensionRunner(
            [extension],
            runtime,
            cwd,
            session_manager,
            model_registry,
        )
        next_session._extension_load_result = LoadExtensionsResult(
            extensions=[extension], errors=[], runtime=runtime
        )
        if session_start_event:
            next_session._session_start_reason = session_start_event.get("reason", "startup")
            previous = session_start_event.get("previousSessionFile")
            if previous:
                next_session._session_start_previous_file = previous
        await next_session.bind_extensions()
        services = type("Services", (), {"agent_dir": agent_dir, "cwd": cwd})()
        return next_session, services, [], None

    runtime_host = AgentSessionRuntime(
        session=session,
        services=type("Services", (), {"agent_dir": str(agent_dir), "cwd": cwd})(),
        diagnostics=[],
        _create_runtime=recreate_runtime,
    )
    return runtime_host, faux


@pytest.mark.anyio
async def test_emits_session_before_switch_and_session_start_for_new_and_resume(tmp_path) -> None:
    events: list[dict[str, Any]] = []

    async def on_before_switch(event: dict[str, Any], _ctx: Any) -> None:
        events.append(dict(event))

    async def on_shutdown(event: dict[str, Any], _ctx: Any) -> None:
        events.append(dict(event))

    async def on_start(event: dict[str, Any], _ctx: Any) -> None:
        events.append(dict(event))

    runtime_host, faux = await _create_runtime_host(
        tmp_path,
        {
            "session_before_switch": [on_before_switch],
            "session_shutdown": [on_shutdown],
            "session_start": [on_start],
        },
    )
    try:
        assert events == [{"type": "session_start", "reason": "startup"}]
        events.clear()

        await runtime_host.session.prompt("hello")
        original_session_file = runtime_host.session.session_file
        assert original_session_file

        new_result = await runtime_host.new_session()
        assert new_result["cancelled"] is False
        second_session_file = runtime_host.session.session_file
        assert events == [
            {"type": "session_before_switch", "reason": "new", "targetSessionFile": None},
            {
                "type": "session_shutdown",
                "reason": "new",
                "targetSessionFile": second_session_file,
            },
            {
                "type": "session_start",
                "reason": "new",
                "previousSessionFile": original_session_file,
            },
        ]

        events.clear()
        switch_result = await runtime_host.switch_session(original_session_file)
        assert switch_result["cancelled"] is False
        assert events == [
            {
                "type": "session_before_switch",
                "reason": "resume",
                "targetSessionFile": original_session_file,
            },
            {
                "type": "session_shutdown",
                "reason": "resume",
                "targetSessionFile": original_session_file,
            },
            {
                "type": "session_start",
                "reason": "resume",
                "previousSessionFile": second_session_file,
            },
        ]
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_honors_session_before_switch_cancellation(tmp_path) -> None:
    events: list[dict[str, Any]] = []

    async def on_before_switch(event: dict[str, Any], _ctx: Any) -> dict[str, bool]:
        events.append(dict(event))
        return {"cancel": True}

    async def on_start(event: dict[str, Any], _ctx: Any) -> None:
        events.append(dict(event))

    runtime_host, faux = await _create_runtime_host(
        tmp_path,
        {
            "session_before_switch": [on_before_switch],
            "session_start": [on_start],
        },
    )
    try:
        events.clear()
        await runtime_host.session.prompt("hello")
        original_session_file = runtime_host.session.session_file

        result = await runtime_host.new_session()
        assert result["cancelled"] is True
        assert runtime_host.session.session_file == original_session_file
        assert events == [
            {"type": "session_before_switch", "reason": "new", "targetSessionFile": None}
        ]
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_runs_before_session_invalidate_after_shutdown(tmp_path) -> None:
    phases: list[str] = []

    async def on_shutdown(_event: dict[str, Any], _ctx: Any) -> None:
        phases.append("session_shutdown")

    runtime_host, faux = await _create_runtime_host(
        tmp_path,
        {"session_shutdown": [on_shutdown]},
    )
    try:
        old_session = runtime_host.session
        old_runner = old_session.extension_runner
        assert old_runner is not None

        runtime_host.set_before_session_invalidate(
            lambda: (
                phases.append("beforeSessionInvalidate"),
                old_runner.create_context(),
            )
        )
        runtime_host.set_rebind_session(lambda: phases.append("rebindSession"))

        await runtime_host.new_session()

        assert phases == ["session_shutdown", "beforeSessionInvalidate", "rebindSession"]
        with pytest.raises(RuntimeError, match="stale"):
            old_runner.create_context().cwd
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_emits_session_before_fork_and_honors_cancellation(tmp_path) -> None:
    events: list[dict[str, Any]] = []
    cancel_next_fork = False

    async def on_before_fork(event: dict[str, Any], _ctx: Any) -> dict[str, bool] | None:
        events.append(dict(event))
        nonlocal cancel_next_fork
        if cancel_next_fork:
            cancel_next_fork = False
            return {"cancel": True}
        return None

    async def on_shutdown(event: dict[str, Any], _ctx: Any) -> None:
        events.append(dict(event))

    async def on_start(event: dict[str, Any], _ctx: Any) -> None:
        events.append(dict(event))

    runtime_host, faux = await _create_runtime_host(
        tmp_path,
        {
            "session_before_fork": [on_before_fork],
            "session_shutdown": [on_shutdown],
            "session_start": [on_start],
        },
    )
    try:
        events.clear()
        await runtime_host.session.prompt("hello")
        user_message = runtime_host.session.get_user_messages_for_forking()[0]
        previous_session_file = runtime_host.session.session_file

        success = await runtime_host.fork(user_message["entryId"])
        assert success["cancelled"] is False
        assert success.get("selectedText") == "hello"
        assert events == [
            {
                "type": "session_before_fork",
                "entryId": user_message["entryId"],
                "position": "before",
            },
            {
                "type": "session_shutdown",
                "reason": "fork",
                "targetSessionFile": runtime_host.session.session_file,
            },
            {
                "type": "session_start",
                "reason": "fork",
                "previousSessionFile": previous_session_file,
            },
        ]

        events.clear()
        cancel_next_fork = True
        cancel_result = await runtime_host.fork(user_message["entryId"])
        assert cancel_result == {"cancelled": True}
        assert events == [
            {
                "type": "session_before_fork",
                "entryId": user_message["entryId"],
                "position": "before",
            }
        ]

        events.clear()
        cancel_next_fork = True
        cancel_at = await runtime_host.fork("missing-entry", {"position": "at"})
        assert cancel_at == {"cancelled": True}
        assert events == [
            {"type": "session_before_fork", "entryId": "missing-entry", "position": "at"}
        ]
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_compaction_extension_cancel_and_custom_summary(tmp_path) -> None:
    captured: list[dict[str, Any]] = []
    custom_summary = "Custom summary from extension"

    async def on_before_compact(event: dict[str, Any], _ctx: Any) -> dict[str, Any]:
        captured.append(dict(event))
        return {
            "compaction": {
                "summary": custom_summary,
                "firstKeptEntryId": event["preparation"]["firstKeptEntryId"],
                "tokensBefore": event["preparation"]["tokensBefore"],
            }
        }

    async def on_compact(event: dict[str, Any], _ctx: Any) -> None:
        captured.append(dict(event))

    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)
    faux = _faux_model()
    model = faux.get_model()
    assert model is not None

    settings_manager = SettingsManager.create(cwd, str(agent_dir))
    auth_storage = AuthStorage.create()
    auth_storage.set_runtime_api_key("faux", "test-key")
    model_registry = ModelRegistry.create(auth_storage)
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd, agent_dir=str(agent_dir), settings_manager=settings_manager
        )
    )
    await resource_loader.reload()
    settings_manager.apply_overrides({"compaction": {"keepRecentTokens": 1}})

    agent = Agent(
        {
            "initialState": {
                "systemPrompt": "test",
                "model": model,
                "thinkingLevel": "off",
                "tools": [],
            }
        }
    )
    session_manager = SessionManager.create(cwd, str(agent_dir / "sessions"))
    session_manager.append_message(create_user_message("first"))
    session_manager.append_message(_assistant_for_compaction("reply one"))
    session_manager.append_message(create_user_message("second"))
    session_manager.append_message(_assistant_for_compaction("reply two"))

    session = AgentSession(
        AgentSessionConfig(
            agent=agent,
            session_manager=session_manager,
            settings_manager=settings_manager,
            cwd=cwd,
            model_registry=model_registry,
            resource_loader=resource_loader,
            no_extensions=True,
        )
    )
    extension = _make_extension(
        {
            "session_before_compact": [on_before_compact],
            "session_compact": [on_compact],
        }
    )
    runtime = create_extension_runtime()
    session._extension_runner = ExtensionRunner(
        [extension], runtime, cwd, session_manager, model_registry
    )
    session._extension_load_result = LoadExtensionsResult(
        extensions=[extension], errors=[], runtime=runtime
    )
    await session.bind_extensions()

    try:
        result = await session.compact()
        assert result["summary"] == custom_summary
        assert result["estimatedTokensAfter"] > 0

        before_events = [event for event in captured if event["type"] == "session_before_compact"]
        compact_events = [event for event in captured if event["type"] == "session_compact"]
        assert len(before_events) == 1
        assert before_events[0]["preparation"]["firstKeptEntryId"]
        assert len(compact_events) == 1
        assert compact_events[0]["compactionEntry"]["summary"] == custom_summary
        assert compact_events[0]["fromExtension"] is True
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_compaction_extension_cancel(tmp_path) -> None:
    captured: list[dict[str, Any]] = []

    async def on_before_compact(event: dict[str, Any], _ctx: Any) -> dict[str, bool]:
        captured.append(dict(event))
        return {"cancel": True}

    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)
    faux = _faux_model()
    model = faux.get_model()
    assert model is not None

    settings_manager = SettingsManager.create(cwd, str(agent_dir))
    auth_storage = AuthStorage.create()
    auth_storage.set_runtime_api_key("faux", "test-key")
    model_registry = ModelRegistry.create(auth_storage)
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd, agent_dir=str(agent_dir), settings_manager=settings_manager
        )
    )
    await resource_loader.reload()
    settings_manager.apply_overrides({"compaction": {"keepRecentTokens": 1}})

    agent = Agent(
        {
            "initialState": {
                "systemPrompt": "test",
                "model": model,
                "thinkingLevel": "off",
                "tools": [],
            }
        }
    )
    session_manager = SessionManager.create(cwd, str(agent_dir / "sessions"))
    session_manager.append_message(create_user_message("hello"))
    session_manager.append_message(_assistant_for_compaction("reply"))
    session_manager.append_message(create_user_message("second"))

    session = AgentSession(
        AgentSessionConfig(
            agent=agent,
            session_manager=session_manager,
            settings_manager=settings_manager,
            cwd=cwd,
            model_registry=model_registry,
            resource_loader=resource_loader,
            no_extensions=True,
        )
    )
    extension = _make_extension({"session_before_compact": [on_before_compact]})
    runtime = create_extension_runtime()
    session._extension_runner = ExtensionRunner(
        [extension], runtime, cwd, session_manager, model_registry
    )
    await session.bind_extensions()

    try:
        with pytest.raises(RuntimeError, match="Compaction cancelled"):
            await session.compact()
        assert not any(event["type"] == "session_compact" for event in captured)
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_navigate_tree_emits_session_tree_and_honors_cancel(tmp_path) -> None:
    events: list[dict[str, Any]] = []

    async def on_before_tree(event: dict[str, Any], _ctx: Any) -> dict[str, bool] | None:
        events.append(dict(event))
        nonlocal cancel_next
        if cancel_next:
            return {"cancel": True}
        return None

    cancel_next = False

    async def on_tree(event: dict[str, Any], _ctx: Any) -> None:
        events.append(dict(event))

    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)
    faux = _faux_model()
    model = faux.get_model()
    assert model is not None

    settings_manager = SettingsManager.create(cwd, str(agent_dir))
    auth_storage = AuthStorage.create()
    model_registry = ModelRegistry.create(auth_storage)
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd, agent_dir=str(agent_dir), settings_manager=settings_manager
        )
    )
    await resource_loader.reload()

    agent = Agent(
        {
            "initialState": {
                "systemPrompt": "test",
                "model": model,
                "thinkingLevel": "off",
                "tools": [],
            }
        }
    )
    session_manager = SessionManager.in_memory(cwd)
    first_id = session_manager.append_message(create_user_message("one"))
    second_id = session_manager.append_message(faux_assistant_message("two"))

    session = AgentSession(
        AgentSessionConfig(
            agent=agent,
            session_manager=session_manager,
            settings_manager=settings_manager,
            cwd=cwd,
            model_registry=model_registry,
            resource_loader=resource_loader,
            no_extensions=True,
        )
    )
    extension = _make_extension(
        {"session_before_tree": [on_before_tree], "session_tree": [on_tree]}
    )
    runtime = create_extension_runtime()
    session._extension_runner = ExtensionRunner(
        [extension], runtime, cwd, session_manager, model_registry
    )
    await session.bind_extensions()

    try:
        result = await session.navigate_tree(first_id)
        assert result["cancelled"] is False
        assert any(event["type"] == "session_tree" for event in events)
        tree_event = next(event for event in events if event["type"] == "session_tree")
        assert tree_event["oldLeafId"] == second_id
        assert tree_event["newLeafId"] is None

        events.clear()
        cancel_next = True
        cancelled = await session.navigate_tree(second_id)
        assert cancelled["cancelled"] is True
        assert events and events[0]["type"] == "session_before_tree"
        assert not any(event["type"] == "session_tree" for event in events)
    finally:
        faux.unregister()
