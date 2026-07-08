import json

import pytest

from pi_mono.coding_agent.modes.rpc.rpc_mode import RpcMode, parse_rpc_command


class _Session:
    def __init__(self) -> None:
        self.retry_enabled: bool | None = None
        self.aborted_retry = False
        self.session_manager = type("SM", (), {"leafId": "leaf"})()

    def set_auto_retry(self, enabled: bool) -> None:
        self.retry_enabled = enabled

    def abort_retry(self) -> None:
        self.aborted_retry = True


class _RuntimeHost:
    def __init__(self, session: _Session) -> None:
        self.session = session

    def set_rebind_session(self, _handler) -> None:
        return None

    async def dispose(self) -> None:
        return None


@pytest.mark.anyio
async def test_rpc_set_auto_retry_and_abort_retry() -> None:
    session = _Session()
    mode = RpcMode(_RuntimeHost(session))  # type: ignore[arg-type]

    set_command = parse_rpc_command(json.dumps({"type": "set_auto_retry", "enabled": False}))
    response = await mode.handle_command(set_command)
    assert response is not None
    assert response["success"] is True
    assert session.retry_enabled is False

    abort_command = parse_rpc_command(json.dumps({"type": "abort_retry"}))
    response = await mode.handle_command(abort_command)
    assert response is not None
    assert response["success"] is True
    assert session.aborted_retry is True
