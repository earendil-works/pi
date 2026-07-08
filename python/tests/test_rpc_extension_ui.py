import asyncio
import json

import pytest

from pi_mono.coding_agent.core.agent_session import AgentSessionRuntime
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.session_manager import SessionManager
from pi_mono.coding_agent.modes.rpc.rpc_mode import RpcExtensionUIContext, RpcMode


async def _make_rpc_mode(tmp_path):
    result = await create_agent_session(
        CreateAgentSessionOptions(
            cwd=str(tmp_path),
            session_manager=SessionManager.in_memory(str(tmp_path)),
        )
    )
    runtime = AgentSessionRuntime(session=result.session, services={}, diagnostics=[])
    return RpcMode(runtime)


@pytest.mark.anyio
async def test_extension_ui_notify_emits_request(tmp_path):
    mode = await _make_rpc_mode(tmp_path)
    emitted: list[dict] = []
    mode.output = emitted.append  # type: ignore[method-assign]

    ui = RpcExtensionUIContext(emitted.append, {})
    ui.notify("hello", "info")

    assert len(emitted) == 1
    assert emitted[0]["type"] == "extension_ui_request"
    assert emitted[0]["method"] == "notify"
    assert emitted[0]["message"] == "hello"
    assert emitted[0]["notifyType"] == "info"


@pytest.mark.anyio
async def test_extension_ui_select_round_trip(tmp_path):
    mode = await _make_rpc_mode(tmp_path)
    ui = mode.get_extension_ui_context()

    async def respond() -> None:
        await asyncio.sleep(0.01)
        pending_id = next(iter(mode._pending_extension_requests))
        mode.handle_extension_ui_response(
            {"type": "extension_ui_response", "id": pending_id, "value": "two"}
        )

    task = asyncio.create_task(ui.select("Pick", ["one", "two"]))
    responder = asyncio.create_task(respond())
    value = await task
    await responder
    assert value == "two"


@pytest.mark.anyio
async def test_handle_input_line_extension_ui_response(tmp_path):
    mode = await _make_rpc_mode(tmp_path)
    resolved: list[str] = []

    def resolver(response: dict) -> None:
        if "value" in response:
            resolved.append(str(response["value"]))

    mode._pending_extension_requests["req-1"] = resolver
    await mode.handle_input_line(
        json.dumps({"type": "extension_ui_response", "id": "req-1", "value": "ok"})
    )
    assert resolved == ["ok"]
    assert "req-1" not in mode._pending_extension_requests
