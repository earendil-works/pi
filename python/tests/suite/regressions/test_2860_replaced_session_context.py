"""Regression #2860: replaced session callbacks invalidate stale extension context."""

from __future__ import annotations

import json
import textwrap
from typing import Any

import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


async def _create_runtime_host(
    tmp_path: Any,
    extension_body: str,
    responses: list[str],
) -> tuple[AgentSessionRuntime, Any]:
    cwd = str(tmp_path)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)

    faux = register_faux_provider({"models": [{"id": "faux-1", "reasoning": False}]})
    faux.set_responses([faux_assistant_message(response) for response in responses])
    model = faux.get_model()
    assert model is not None

    auth_storage = AuthStorage.create()
    auth_storage.set_runtime_api_key(model["provider"], "faux-key")
    model_registry = ModelRegistry.create(auth_storage)
    settings_manager = SettingsManager.create(cwd, str(agent_dir))

    ext_dir = tmp_path / ".pi" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    ext_file = ext_dir / "repro.py"
    ext_file.write_text(
        "async def default(pi):\n" + textwrap.indent(extension_body.strip("\n"), "    ") + "\n",
        encoding="utf-8",
    )

    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=cwd,
            agent_dir=str(agent_dir),
            auth_storage=auth_storage,
            model_registry=model_registry,
            settings_manager=settings_manager,
            session_manager=SessionManager.create(cwd, str(agent_dir / "sessions")),
            model=model,
            no_tools="all",
        )
    )
    session = result.session

    runtime_host = AgentSessionRuntime(
        session=session,
        services=type("Services", (), {"agent_dir": str(agent_dir), "cwd": cwd})(),
        diagnostics=[],
    )

    async def recreate_runtime(
        *,
        cwd: str,
        agent_dir: str,
        session_manager: SessionManager,
        session_start_event: dict[str, Any] | None = None,
    ) -> tuple[Any, Any, list[dict[str, str]], str | None]:
        next_settings = SettingsManager.create(
            cwd,
            agent_dir,
            project_trusted=settings_manager.is_project_trusted(),
        )
        next_result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=cwd,
                agent_dir=agent_dir,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=next_settings,
                session_manager=session_manager,
                model=model,
                no_tools="all",
            )
        )
        next_session = next_result.session
        if session_start_event:
            next_session._session_start_reason = session_start_event.get("reason", "startup")
            previous = session_start_event.get("previousSessionFile")
            if previous:
                next_session._session_start_previous_file = previous
        services = type("Services", (), {"agent_dir": agent_dir, "cwd": cwd})()
        return next_session, services, [], None

    runtime_host._create_runtime = recreate_runtime

    async def rebind_session() -> None:
        current = runtime_host.session
        await current.bind_extensions(
            command_context_actions={
                "waitForIdle": current.agent.waitForIdle,
                "newSession": runtime_host.new_session,
                "fork": runtime_host.fork,
                "navigateTree": current.navigate_tree,
                "switchSession": runtime_host.switch_session,
                "reload": current.reload,
            }
        )

    runtime_host.set_rebind_session(rebind_session)
    await session.bind_extensions(
        command_context_actions={
            "waitForIdle": session.agent.waitForIdle,
            "newSession": runtime_host.new_session,
            "fork": runtime_host.fork,
            "navigateTree": session.navigate_tree,
            "switchSession": runtime_host.switch_session,
            "reload": session.reload,
        }
    )
    return runtime_host, faux


@pytest.mark.anyio
async def test_rebinds_before_with_session_and_invalidates_stale_context(tmp_path) -> None:
    state_file = tmp_path / "state.json"

    extension_body = f"""
import json
from pathlib import Path

STATE_PATH = Path({str(state_file)!r})

def read_state():
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {{}}

def write_state(**updates):
    current = read_state()
    current.update(updates)
    STATE_PATH.write_text(json.dumps(current), encoding="utf-8")

def get_instance_id():
    return read_state().get("instance_id", 0)

async def on_session_start(_event, _ctx):
    instance_id = get_instance_id() + 1
    events = read_state().get("events", [])
    events.append(f"start:{{instance_id}}")
    write_state(instance_id=instance_id, events=events)

async def on_session_shutdown(_event, _ctx):
    instance_id = get_instance_id()
    events = read_state().get("events", [])
    events.append(f"shutdown:{{instance_id}}")
    write_state(events=events)

async def repro_handler(_args, ctx):
    command_instance = get_instance_id()
    old_session_file = ctx.session_manager.get_session_file()
    old_ctx = ctx

    async def with_session(replaced_ctx):
        events = read_state().get("events", [])
        events.append(f"with:{{command_instance}}")
        stale_ctx_throws = False
        stale_pi_throws = False
        try:
            old_ctx.session_manager.get_session_file()
        except RuntimeError:
            stale_ctx_throws = True
        try:
            pi.send_user_message("stale message")
        except RuntimeError:
            stale_pi_throws = True
        await replaced_ctx.send_user_message("Hello from the new session!")
        write_state(
            events=events,
            old_session_file=old_session_file,
            replacement_session_file=replaced_ctx.session_manager.get_session_file(),
            stale_ctx_throws=stale_ctx_throws,
            stale_pi_throws=stale_pi_throws,
        )

    await ctx.new_session({{"withSession": with_session}})

pi.on("session_start", on_session_start)
pi.on("session_shutdown", on_session_shutdown)
pi.register_command("repro", {{"description": "repro", "handler": repro_handler}})
"""

    runtime_host, faux = await _create_runtime_host(tmp_path, extension_body, ["hello reply"])
    try:
        commands = {
            command.invocation_name
            for command in runtime_host.session.extension_runner.get_registered_commands()
        }
        assert "repro" in commands

        await runtime_host.session.prompt("/repro")

        state = json.loads(state_file.read_text(encoding="utf-8"))
        assert state["events"] == ["start:1", "shutdown:1", "start:2", "with:1"]
        assert state["replacement_session_file"] != state["old_session_file"]
        assert state["stale_ctx_throws"] is True
        assert state["stale_pi_throws"] is True
        messages = [
            f"{message['role']}:{_message_text(message)}"
            for message in runtime_host.session.messages
        ]
        assert messages == [
            "user:Hello from the new session!",
            "assistant:hello reply",
        ]
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_supports_with_session_for_fork(tmp_path) -> None:
    extension_body = """
async def fork_handler(_args, ctx):
    leaf_id = ctx.session_manager.get_leaf_id()
    if not leaf_id:
        raise RuntimeError("Missing leaf id")

    async def with_session(replaced_ctx):
        await replaced_ctx.send_user_message("fork callback message")

    await ctx.fork(leaf_id, {"position": "at", "withSession": with_session})

pi.register_command("fork-it", {"description": "fork-it", "handler": fork_handler})
"""

    runtime_host, faux = await _create_runtime_host(
        tmp_path,
        extension_body,
        ["seed reply", "fork reply"],
    )
    try:
        await runtime_host.session.prompt("seed")
        await runtime_host.session.prompt("/fork-it")
        messages = [
            f"{message['role']}:{_message_text(message)}"
            for message in runtime_host.session.messages
        ]
        assert messages == [
            "user:seed",
            "assistant:seed reply",
            "user:fork callback message",
            "assistant:fork reply",
        ]
    finally:
        faux.unregister()


@pytest.mark.anyio
async def test_supports_with_session_for_switch_session(tmp_path) -> None:
    target_file = tmp_path / "target-session.txt"

    extension_body = f"""
from pathlib import Path

TARGET_PATH = Path({str(target_file)!r})

async def switch_handler(_args, ctx):
    async def with_session(replaced_ctx):
        await replaced_ctx.send_user_message("switch callback message")

    target = TARGET_PATH.read_text(encoding="utf-8")
    await ctx.switch_session(target, {{"withSession": with_session}})

pi.register_command("switch-it", {{"description": "switch-it", "handler": switch_handler}})
"""

    runtime_host, faux = await _create_runtime_host(
        tmp_path,
        extension_body,
        ["root reply", "target reply", "switch reply"],
    )
    try:
        await runtime_host.session.prompt("root")
        original_session_path = runtime_host.session.session_file
        new_session_result = await runtime_host.new_session()
        assert new_session_result["cancelled"] is False
        await runtime_host.session.prompt("target")
        target_file.write_text(runtime_host.session.session_file or "", encoding="utf-8")
        await runtime_host.switch_session(original_session_path)

        await runtime_host.session.prompt("/switch-it")
        assert runtime_host.session.session_file == target_file.read_text(encoding="utf-8")
        messages = [
            f"{message['role']}:{_message_text(message)}"
            for message in runtime_host.session.messages
        ]
        assert messages == [
            "user:target",
            "assistant:target reply",
            "user:switch callback message",
            "assistant:switch reply",
        ]
    finally:
        faux.unregister()
