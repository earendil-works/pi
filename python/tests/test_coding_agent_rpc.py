import json

import pytest

from pi_mono.agent.harness.messages import create_user_message
from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.session_manager import SessionManager
from pi_mono.coding_agent.modes.rpc.jsonl import JsonlLineReader, serialize_json_line
from pi_mono.coding_agent.modes.rpc.rpc_mode import (
    RpcMode,
    build_error_response,
    build_session_state,
    build_success_response,
    parse_rpc_command,
)


async def _make_rpc_mode(tmp_path):
    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    session = result.session
    runtime = AgentSessionRuntime(session=session, services={}, diagnostics=[])
    return RpcMode(runtime), session, runtime


def test_serialize_json_line():
    assert (
        serialize_json_line({"type": "prompt", "message": "hi"})
        == '{"type":"prompt","message":"hi"}\n'
    )


def test_jsonl_line_reader_splits_lf_only():
    lines: list[str] = []
    reader = JsonlLineReader(lines.append)
    reader.feed('{"a":1}\n{"b":2}\n')
    assert lines == ['{"a":1}', '{"b":2}']


def test_parse_rpc_command():
    command = parse_rpc_command('{"type":"get_state","id":"1"}')
    assert command["type"] == "get_state"
    assert command["id"] == "1"


def test_parse_rpc_command_invalid():
    with pytest.raises(ValueError):
        parse_rpc_command('"not-an-object"')


def test_build_responses():
    success = build_success_response("1", "abort")
    assert success["success"] is True
    assert success["command"] == "abort"

    error = build_error_response("1", "prompt", "failed")
    assert error["success"] is False
    assert error["error"] == "failed"


@pytest.mark.anyio
async def test_rpc_mode_handle_get_state(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)

    response = await mode.handle_command(
        parse_rpc_command(json.dumps({"type": "get_state", "id": "abc"}))
    )
    assert response is not None
    assert response["success"] is True
    assert response["command"] == "get_state"
    assert response["data"]["sessionId"] == session.session_id
    state = build_session_state(session)
    assert state["steeringMode"] == session.steering_mode
    assert state["followUpMode"] == session.follow_up_mode
    assert state["autoCompactionEnabled"] == session.auto_compaction_enabled


@pytest.mark.anyio
async def test_rpc_mode_handle_get_commands(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)
    session._resource_loader._prompts = [  # type: ignore[attr-defined]
        {"name": "review", "description": "Review code", "content": "Review"}
    ]
    session._resource_loader._skills = [  # type: ignore[attr-defined]
        {
            "name": "deploy",
            "description": "Deploy app",
            "content": "steps",
            "filePath": str(tmp_path / "SKILL.md"),
        }
    ]

    response = await mode.handle_command(parse_rpc_command('{"type":"get_commands"}'))
    assert response is not None
    assert response["success"] is True
    command_names = {item["name"] for item in response["data"]["commands"]}
    assert "review" in command_names
    assert "skill:deploy" in command_names
    assert "model" not in command_names


@pytest.mark.anyio
async def test_rpc_mode_handle_steer_and_follow_up(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)

    steer = await mode.handle_command(
        parse_rpc_command('{"type":"steer","message":"interrupt me"}')
    )
    assert steer is not None and steer["success"] is True

    follow_up = await mode.handle_command(
        parse_rpc_command('{"type":"follow_up","message":"after done"}')
    )
    assert follow_up is not None and follow_up["success"] is True

    state = await mode.handle_command(parse_rpc_command('{"type":"get_state"}'))
    assert state is not None
    assert state["data"]["pendingMessageCount"] == session.pending_message_count
    assert session.pending_message_count >= 2


@pytest.mark.anyio
async def test_rpc_mode_handle_queue_modes(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)

    await mode.handle_command(parse_rpc_command('{"type":"set_steering_mode","mode":"all"}'))
    await mode.handle_command(parse_rpc_command('{"type":"set_follow_up_mode","mode":"all"}'))

    assert session.steering_mode == "all"
    assert session.follow_up_mode == "all"

    state = await mode.handle_command(parse_rpc_command('{"type":"get_state"}'))
    assert state is not None
    assert state["data"]["steeringMode"] == "all"
    assert state["data"]["followUpMode"] == "all"


@pytest.mark.anyio
async def test_rpc_mode_handle_cycle_model_and_thinking_level(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)

    cycle_model = await mode.handle_command(parse_rpc_command('{"type":"cycle_model"}'))
    assert cycle_model is not None and cycle_model["success"] is True

    cycle_thinking = await mode.handle_command(parse_rpc_command('{"type":"cycle_thinking_level"}'))
    assert cycle_thinking is not None and cycle_thinking["success"] is True
    if session.supports_thinking():
        assert cycle_thinking["data"]["level"] is not None
    else:
        assert "data" in cycle_thinking
        assert cycle_thinking["data"] is None


@pytest.mark.anyio
async def test_rpc_mode_handle_bash(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)

    response = await mode.handle_command(
        parse_rpc_command('{"type":"bash","command":"echo rpc-bash-ok"}')
    )
    assert response is not None and response["success"] is True
    assert "rpc-bash-ok" in response["data"]["output"]
    assert response["data"]["exitCode"] == 0
    assert any(message.get("role") == "bashExecution" for message in session.messages)


@pytest.mark.anyio
async def test_rpc_mode_handle_session_stats_and_last_assistant_text(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)

    session.agent.state.messages.append(
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "final answer"}],
            "api": "openai-responses",
            "provider": "openai",
            "model": "gpt-4.1",
            "usage": {
                "input": 1,
                "output": 2,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 3,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            },
            "stopReason": "stop",
            "timestamp": 1,
        }
    )

    stats = await mode.handle_command(parse_rpc_command('{"type":"get_session_stats"}'))
    assert stats is not None and stats["success"] is True
    assert stats["data"]["assistantMessages"] == 1
    assert stats["data"]["tokens"]["input"] == 1

    last_text = await mode.handle_command(parse_rpc_command('{"type":"get_last_assistant_text"}'))
    assert last_text is not None and last_text["success"] is True
    assert last_text["data"]["text"] == "final answer"


@pytest.mark.anyio
async def test_rpc_mode_handle_set_session_name(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)

    response = await mode.handle_command(
        parse_rpc_command('{"type":"set_session_name","name":"rpc-test"}')
    )
    assert response is not None and response["success"] is True
    assert session.session_name == "rpc-test"

    state = await mode.handle_command(parse_rpc_command('{"type":"get_state"}'))
    assert state is not None
    assert state["data"]["sessionName"] == "rpc-test"


@pytest.mark.anyio
async def test_rpc_mode_handle_fork_messages_and_new_session(tmp_path):
    mode, session, runtime = await _make_rpc_mode(tmp_path)

    user_message = create_user_message("fork candidate")
    session.session_manager.append_message(user_message)

    fork_messages = await mode.handle_command(parse_rpc_command('{"type":"get_fork_messages"}'))
    assert fork_messages is not None and fork_messages["success"] is True
    assert len(fork_messages["data"]["messages"]) == 1
    assert fork_messages["data"]["messages"][0]["text"] == "fork candidate"

    entry_id = fork_messages["data"]["messages"][0]["entryId"]
    old_session_id = session.session_id
    forked = await mode.handle_command(
        parse_rpc_command(json.dumps({"type": "fork", "entryId": entry_id}))
    )
    assert forked is not None and forked["success"] is True
    assert forked["data"]["cancelled"] is False
    assert forked["data"]["text"] == "fork candidate"
    assert runtime.session.session_id != old_session_id

    new_session = await mode.handle_command(parse_rpc_command('{"type":"new_session"}'))
    assert new_session is not None and new_session["success"] is True
    assert new_session["data"]["cancelled"] is False


@pytest.mark.anyio
async def test_rpc_mode_handle_compact_without_model(tmp_path):
    mode, session, _runtime = await _make_rpc_mode(tmp_path)
    session.agent.state.model = None

    with pytest.raises(RuntimeError, match="No model selected"):
        await mode.handle_command(parse_rpc_command('{"type":"compact"}'))
