"""RpcClient unit and integration tests."""

from __future__ import annotations

import asyncio
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

from pi_mono.coding_agent.modes.rpc.rpc_client import RpcClient, RpcClientOptions


def _fake_rpc_server_script() -> str:
    return textwrap.dedent(
        """
        import json
        import sys

        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            command = json.loads(line)
            command_type = command.get("type")
            request_id = command.get("id")
            response: dict[str, object] = {
                "type": "response",
                "id": request_id,
                "success": True,
                "command": command_type,
            }
            if command_type == "get_state":
                response["data"] = {
                    "sessionId": "session-1",
                    "messageCount": 0,
                    "isStreaming": False,
                }
            elif command_type == "get_commands":
                response["data"] = {"commands": [{"name": "model", "description": "model"}]}
            elif command_type == "clone":
                response["data"] = {"cancelled": False}
            elif command_type == "get_fork_messages":
                response["data"] = {"messages": [{"entryId": "u1", "text": "hello"}]}
            else:
                response["data"] = {}
            sys.stdout.write(json.dumps(response) + "\\n")
            sys.stdout.flush()
        """
    )


def _exit_on_input_script(exit_code: int = 43) -> str:
    return textwrap.dedent(
        f"""
        import sys
        sys.stdin.readline()
        raise SystemExit({exit_code})
        """
    )


@pytest.mark.anyio
async def test_rpc_client_get_state_over_fake_server(tmp_path: Path) -> None:
    script = tmp_path / "fake_rpc.py"
    script.write_text(_fake_rpc_server_script(), encoding="utf-8")
    client = RpcClient(
        RpcClientOptions(
            command=[sys.executable, str(script)],
            cwd=str(tmp_path),
            startup_delay_ms=0,
        )
    )
    try:
        await client.start()
        state = await client.get_state()
        assert state["sessionId"] == "session-1"
        assert state["messageCount"] == 0
    finally:
        await client.stop()


@pytest.mark.anyio
async def test_rpc_client_clone_sends_clone_command(tmp_path: Path) -> None:
    script = tmp_path / "fake_rpc.py"
    script.write_text(_fake_rpc_server_script(), encoding="utf-8")
    client = RpcClient(
        RpcClientOptions(
            command=[sys.executable, str(script)],
            cwd=str(tmp_path),
            startup_delay_ms=0,
        )
    )
    sent: list[dict[str, Any]] = []
    original_send = client._send

    async def capture_send(command: dict[str, Any]) -> dict[str, Any]:
        sent.append(command)
        return await original_send(command)

    client._send = capture_send  # type: ignore[method-assign]
    try:
        await client.start()
        result = await client.clone()
        assert result == {"cancelled": False}
        assert sent[-1]["type"] == "clone"
    finally:
        await client.stop()


@pytest.mark.anyio
async def test_rpc_client_collects_agent_events(tmp_path: Path) -> None:
    script = tmp_path / "fake_rpc.py"
    script.write_text(
        textwrap.dedent(
            """
            import json
            import sys

            for raw_line in sys.stdin:
                line = raw_line.strip()
                if not line:
                    continue
                command = json.loads(line)
                if command.get("type") == "prompt":
                    sys.stdout.write(json.dumps({"type": "agent_start"}) + "\\n")
                    sys.stdout.flush()
                    sys.stdout.write(json.dumps({"type": "agent_end", "messages": []}) + "\\n")
                    sys.stdout.flush()
                    response = {
                        "type": "response",
                        "id": command.get("id"),
                        "success": True,
                        "command": "prompt",
                        "data": {},
                    }
                    sys.stdout.write(json.dumps(response) + "\\n")
                    sys.stdout.flush()
            """
        ),
        encoding="utf-8",
    )
    client = RpcClient(
        RpcClientOptions(
            command=[sys.executable, str(script)],
            cwd=str(tmp_path),
            startup_delay_ms=0,
        )
    )
    try:
        await client.start()
        collect_task = asyncio.create_task(client.collect_events(timeout=2))
        await client.prompt("hello")
        events = await collect_task
        assert [event["type"] for event in events] == ["agent_start", "agent_end"]
    finally:
        await client.stop()


@pytest.mark.anyio
async def test_rpc_client_rejects_in_flight_request_when_child_exits(tmp_path: Path) -> None:
    script = tmp_path / "exit_child.py"
    script.write_text(_exit_on_input_script(43), encoding="utf-8")
    client = RpcClient(
        RpcClientOptions(
            command=[sys.executable, str(script)],
            cwd=str(tmp_path),
            startup_delay_ms=0,
        )
    )
    await client.start()
    with pytest.raises(RuntimeError, match=r"Agent process exited \(code=43 signal=None\)"):
        await client.get_commands()


@pytest.mark.anyio
async def test_rpc_client_get_fork_messages(tmp_path: Path) -> None:
    script = tmp_path / "fake_rpc.py"
    script.write_text(_fake_rpc_server_script(), encoding="utf-8")
    client = RpcClient(
        RpcClientOptions(
            command=[sys.executable, str(script)],
            cwd=str(tmp_path),
            startup_delay_ms=0,
        )
    )
    try:
        await client.start()
        messages = await client.get_fork_messages()
        assert messages == [{"entryId": "u1", "text": "hello"}]
    finally:
        await client.stop()


@pytest.mark.anyio
async def test_rpc_client_wait_for_idle_times_out_without_agent_end(tmp_path: Path) -> None:
    script = tmp_path / "fake_rpc.py"
    script.write_text(_fake_rpc_server_script(), encoding="utf-8")
    client = RpcClient(
        RpcClientOptions(
            command=[sys.executable, str(script)],
            cwd=str(tmp_path),
            startup_delay_ms=0,
        )
    )
    try:
        await client.start()
        with pytest.raises(RuntimeError, match="Timeout waiting for agent to become idle"):
            await client.wait_for_idle(timeout=0.05)
    finally:
        await client.stop()
