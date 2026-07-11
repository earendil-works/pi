"""Focused tests for v0.80 coding-agent feature ports."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pi_mono.ai.providers.simple_options import build_base_options
from pi_mono.ai.types import Model
from pi_mono.ai.utils.estimate import estimate_context_tokens
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.coding_agent.modes.rpc.rpc_mode import RpcMode, parse_rpc_command
from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
from pi_mono.core.session_manager import SessionManager, build_session_context
from pi_mono.core.settings_manager import SettingsManager


@pytest.fixture
def test_dirs(tmp_path: Path):
    agent_dir = tmp_path / "agent"
    project_dir = tmp_path / "project"
    agent_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / ".pi").mkdir(parents=True, exist_ok=True)
    return {
        "agent_dir": str(agent_dir),
        "project_dir": str(project_dir),
        "global_settings_path": str(agent_dir / "settings.json"),
    }


def test_shell_path_expands_tilde(test_dirs, monkeypatch):
    home = Path(test_dirs["agent_dir"]).parent / "home"
    home.mkdir()
    monkeypatch.setattr("pi_mono.utils.paths.Path.home", lambda: home)

    with open(test_dirs["global_settings_path"], "w", encoding="utf-8") as f:
        json.dump({"shellPath": "~/bin/myshell"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_shell_path() == str(home / "bin" / "myshell")


def test_external_editor_setting_overrides_env(test_dirs, monkeypatch):
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    with open(test_dirs["global_settings_path"], "w", encoding="utf-8") as f:
        json.dump({"externalEditor": "code --wait"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_external_editor_command() == "code --wait"


def test_external_editor_defaults_to_nano_or_notepad(test_dirs, monkeypatch):
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    command = manager.get_external_editor_command()
    assert command in ("nano", "notepad")


def test_output_pad_and_cache_miss_settings(test_dirs):
    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_output_pad() == 1
    assert manager.get_show_cache_miss_notices() is False

    manager.set_output_pad(0)
    manager.set_show_cache_miss_notices(True)
    assert manager.get_output_pad() == 0
    assert manager.get_show_cache_miss_notices() is True


def test_estimate_context_tokens_ignores_stale_assistant_usage():
    context = {
        "systemPrompt": "system",
        "messages": [
            {"role": "user", "content": "summary", "timestamp": 200},
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "kept"}],
                "api": "openai-responses",
                "provider": "openai",
                "model": "test-model",
                "usage": {
                    "input": 9500,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 9500,
                    "cost": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0,
                    },
                },
                "stopReason": "stop",
                "timestamp": 100,
            },
            {"role": "user", "content": "x" * 4000, "timestamp": 300},
        ],
    }
    estimate = estimate_context_tokens(context)
    assert estimate.last_usage_index is None
    assert estimate.usage_tokens == 0
    assert estimate.tokens == 1005

    model: Model = {
        "id": "test-model",
        "name": "Test Model",
        "api": "openai-responses",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 10_000,
        "maxTokens": 8_000,
    }
    options = build_base_options(model, context)
    assert options["maxTokens"] == 4899


def test_null_message_content_normalized_in_session_context():
    entries = [
        {
            "id": "u1",
            "type": "message",
            "parentId": None,
            "timestamp": "2026-01-01T00:00:00.000Z",
            "message": {"role": "user", "content": None, "timestamp": 1},
        },
        {
            "id": "a1",
            "type": "message",
            "parentId": "u1",
            "timestamp": "2026-01-01T00:00:01.000Z",
            "message": {
                "role": "assistant",
                "content": None,
                "api": "openai-responses",
                "provider": "openai",
                "model": "test",
                "usage": {
                    "input": 1,
                    "output": 1,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 2,
                    "cost": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0,
                    },
                },
                "stopReason": "stop",
                "timestamp": 2,
            },
        },
        {
            "id": "c1",
            "type": "custom_message",
            "parentId": "a1",
            "timestamp": "2026-01-01T00:00:02.000Z",
            "customType": "note",
            "content": None,
            "display": True,
            "details": None,
        },
    ]
    context = build_session_context(entries, "c1")
    assert context["messages"][0]["content"] == []
    assert context["messages"][1]["content"] == []
    assert context["messages"][2]["content"] == []


@pytest.mark.anyio
async def test_rpc_get_entries_and_get_tree(tmp_path: Path) -> None:
    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
            no_extensions=True,
            no_tools="all",
        )
    )
    session = result.session
    runtime = AgentSessionRuntime(session=session, services={}, diagnostics=[])
    mode = RpcMode(runtime)

    session.session_manager.append_message(
        {"role": "user", "content": [{"type": "text", "text": "hi"}], "timestamp": 1}
    )
    first_message_id = next(
        entry["id"]
        for entry in session.session_manager.get_entries()
        if entry.get("type") == "message"
    )
    session.session_manager.append_message(
        {"role": "user", "content": [{"type": "text", "text": "again"}], "timestamp": 2}
    )

    entries_response = await mode.handle_command(
        parse_rpc_command(json.dumps({"id": "1", "type": "get_entries"}))
    )
    assert entries_response is not None and entries_response["success"] is True
    message_entries = [
        entry for entry in entries_response["data"]["entries"] if entry.get("type") == "message"
    ]
    assert len(message_entries) == 2
    assert entries_response["data"]["leafId"] == session.session_manager.get_leaf_id()

    since_response = await mode.handle_command(
        parse_rpc_command(
            json.dumps({"id": "2", "type": "get_entries", "since": first_message_id})
        )
    )
    assert since_response is not None and since_response["success"] is True
    assert len(since_response["data"]["entries"]) == 1
    assert since_response["data"]["entries"][0]["message"]["content"][0]["text"] == "again"

    tree_response = await mode.handle_command(
        parse_rpc_command(json.dumps({"id": "3", "type": "get_tree"}))
    )
    assert tree_response is not None and tree_response["success"] is True
    assert isinstance(tree_response["data"]["tree"], list)
    assert tree_response["data"]["leafId"] == session.session_manager.get_leaf_id()


@pytest.mark.anyio
async def test_session_info_changed_emits_to_session_subscribers(tmp_path: Path) -> None:
    events: list[dict] = []
    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
            no_extensions=True,
            no_tools="all",
        )
    )
    session = result.session
    session.subscribe(lambda event: events.append(event))
    session.set_session_name("named")
    changed = [event for event in events if event.get("type") == "session_info_changed"]
    assert [event.get("name") for event in changed] == ["named"]
