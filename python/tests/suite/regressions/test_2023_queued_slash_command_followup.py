"""Regression #2023: extension follow-ups with slash text are not dispatched as commands."""

from __future__ import annotations

import asyncio
import textwrap

import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, faux_tool_call, register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _write_extension(tmp_path, body: str) -> None:
    ext_dir = tmp_path / ".pi" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    (ext_dir / "testcmd.py").write_text(
        "async def default(pi):\n" + textwrap.indent(body.strip("\n"), "    ") + "\n",
        encoding="utf-8",
    )


@pytest.mark.anyio
async def test_extension_follow_up_slash_text_is_not_dispatched(tmp_path) -> None:
    release_event = asyncio.Event()
    command_runs: list[str] = []

    _write_extension(
        tmp_path,
        """
        async def on_session_start(event, ctx):
            async def execute_wait(tool_call_id, params, signal=None, on_update=None):
                await release_event.wait()
                return {"content": [{"type": "text", "text": "released"}], "details": {}}

            from pi_mono.coding_agent.core.extensions.types import ToolDefinition

            pi.register_tool(
                ToolDefinition(
                    name="wait",
                    label="Wait",
                    description="Wait for the test to release execution",
                    parameters={"type": "object", "properties": {}},
                    execute=execute_wait,
                )
            )
            pi.register_command(
                "testcmd",
                {
                    "description": "Test command",
                    "handler": lambda args, ctx: command_runs.append(args),
                },
            )
        pi.on("session_start", on_session_start)
        """,
    )

    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        faux.set_responses(
            [
                faux_assistant_message(faux_tool_call("wait", {}), {"stopReason": "toolUse"}),
                faux_assistant_message("first turn complete"),
                faux_assistant_message("queued follow-up handled by model"),
            ]
        )
        model = faux.get_model()
        assert model is not None

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                agent_dir=str(tmp_path / "agent"),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=ModelRegistry.create(auth_storage),
                settings_manager=SettingsManager.create(str(tmp_path)),
                no_tools="all",
            )
        )
        session = result.session
        await session.bind_extensions()
        extension_runner = session.extension_runner
        assert extension_runner is not None

        saw_tool_start = asyncio.Event()

        def on_event(event: dict) -> None:
            if event.get("type") == "tool_execution_start" and event.get("toolName") == "wait":
                saw_tool_start.set()

        session.subscribe(on_event)
        prompt_task = asyncio.create_task(session.prompt("start"))
        await asyncio.wait_for(saw_tool_start.wait(), timeout=5)
        await asyncio.sleep(0)

        await session.send_user_message("/testcmd queued", {"deliverAs": "followUp"})
        release_event.set()
        await asyncio.wait_for(prompt_task, timeout=10)

        user_texts = [
            "".join(
                part.get("text", "")
                for part in message.get("content", [])
                if part.get("type") == "text"
            )
            for message in session.messages
            if message.get("role") == "user"
        ]
        assistant_texts = [
            "".join(
                part.get("text", "")
                for part in message.get("content", [])
                if part.get("type") == "text"
            )
            for message in session.messages
            if message.get("role") == "assistant"
        ]

        assert command_runs == []
        assert user_texts == ["start", "/testcmd queued"]
        assert "queued follow-up handled by model" in assistant_texts
    finally:
        faux.set_responses([])
