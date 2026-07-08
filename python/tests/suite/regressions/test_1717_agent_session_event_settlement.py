"""Regressions #1717/#2113: agent session event settlement."""

from __future__ import annotations

import asyncio
import json
import textwrap

import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, faux_tool_call, register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _write_extension(tmp_path, *parts: str) -> None:
    ext_dir = tmp_path / ".pi" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    ext_file = ext_dir / "settlement.py"
    normalized_body = "\n\n".join(
        textwrap.dedent(part).strip("\n") for part in parts if part.strip()
    )
    ext_file.write_text(
        "async def default(pi):\n" + textwrap.indent(normalized_body, "    ") + "\n",
        encoding="utf-8",
    )


_ECHO_TOOL_SETUP = """
from pi_mono.coding_agent.core.extensions.types import ToolDefinition

async def execute_echo(_tool_call_id, params, signal=None, on_update=None):
    text = params.get("text", "") if isinstance(params, dict) else ""
    return {"content": [{"type": "text", "text": str(text)}], "details": {"text": text}}

async def on_session_start(_event, _ctx):
    pi.register_tool(
        ToolDefinition(
            name="echo",
            label="Echo",
            description="Echo text back",
            parameters={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
            execute=execute_echo,
        )
    )

pi.on("session_start", on_session_start)
"""


@pytest.mark.anyio
async def test_keeps_message_order_when_message_end_handlers_yield(tmp_path) -> None:
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        faux.set_responses(
            [
                faux_assistant_message(
                    [
                        faux_tool_call("echo", {"text": "one"}),
                        faux_tool_call("echo", {"text": "two"}),
                    ],
                    {"stopReason": "toolUse"},
                ),
                faux_assistant_message("done"),
            ]
        )
        model = faux.get_model()
        assert model is not None

        _write_extension(
            tmp_path,
            _ECHO_TOOL_SETUP,
            """
            async def on_message_end(event, _ctx):
                if event["message"].get("role") == "assistant":
                    await asyncio.sleep(0.02)

            pi.on("message_end", on_message_end)
            """,
        )

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        model_registry = ModelRegistry.create(auth_storage)
        settings_manager = SettingsManager.create(str(tmp_path))

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                agent_dir=str(tmp_path / "agent"),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=settings_manager,
            )
        )
        session = result.session
        await session.bind_extensions()
        await session.prompt("run tools")

        branch_messages = [
            entry["message"]
            for entry in session.session_manager.get_branch()
            if entry.get("type") == "message"
        ]
        assert [message.get("role") for message in branch_messages] == [
            "user",
            "assistant",
            "toolResult",
            "toolResult",
            "assistant",
        ]
        first_tool_result_index = next(
            index
            for index, message in enumerate(branch_messages)
            if message.get("role") == "toolResult"
        )
        assert first_tool_result_index > 0
        assert branch_messages[first_tool_result_index - 1].get("role") == "assistant"
    finally:
        faux.set_responses([])


@pytest.mark.anyio
async def test_tool_call_handlers_see_settled_assistant_message(tmp_path) -> None:
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    roles_file = tmp_path / "roles.json"
    try:
        faux.set_responses(
            [
                faux_assistant_message(
                    [faux_tool_call("echo", {"text": "hello"})],
                    {"stopReason": "toolUse"},
                ),
                faux_assistant_message("done"),
            ]
        )
        model = faux.get_model()
        assert model is not None

        _write_extension(
            tmp_path,
            _ECHO_TOOL_SETUP,
            f"""
            import json
            from pathlib import Path

            ROLES_PATH = Path({str(roles_file)!r})

            async def on_tool_call(_event, ctx):
                roles = [
                    entry["message"]["role"]
                    for entry in ctx.session_manager.get_branch()
                    if entry.get("type") == "message"
                ]
                ROLES_PATH.write_text(json.dumps(roles), encoding="utf-8")

            pi.on("tool_call", on_tool_call)
            """,
        )

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        model_registry = ModelRegistry.create(auth_storage)
        settings_manager = SettingsManager.create(str(tmp_path))

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                agent_dir=str(tmp_path / "agent"),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=settings_manager,
            )
        )
        session = result.session
        await session.bind_extensions()
        await session.prompt("run tool")

        assert json.loads(roles_file.read_text(encoding="utf-8")) == ["user", "assistant"]
    finally:
        faux.set_responses([])
