"""Regression #3686: session name changes emit session_info_changed."""

from __future__ import annotations

import pytest

from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.session_manager import SessionManager


@pytest.mark.anyio
async def test_set_session_name_emits_session_info_changed(tmp_path) -> None:
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

    session.set_session_name("hello world")

    assert session.session_manager.get_session_name() == "hello world"
    changed = [event for event in events if event.get("type") == "session_info_changed"]
    assert [event.get("name") for event in changed] == ["hello world"]
