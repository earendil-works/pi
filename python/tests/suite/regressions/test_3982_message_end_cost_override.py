"""Regression #3982: message_end handlers can override assistant usage cost."""

from __future__ import annotations

import textwrap

import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


def _write_extension(tmp_path, name: str, body: str) -> str:
    ext_dir = tmp_path / ".pi" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    ext_file = ext_dir / f"{name}.py"
    ext_file.write_text(
        "async def default(pi):\n" + textwrap.indent(body.strip("\n"), "    ") + "\n",
        encoding="utf-8",
    )
    return str(ext_dir)


@pytest.mark.anyio
async def test_message_end_cost_override(tmp_path) -> None:
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        faux.set_responses([faux_assistant_message("hello")])
        model = faux.get_model()
        assert model is not None

        ext_dir = _write_extension(
            tmp_path,
            "cost_override",
            """
            async def on_message_end(event, ctx):
                message = event["message"]
                if message.get("role") != "assistant":
                    return None
                usage = dict(message.get("usage") or {})
                cost = dict(usage.get("cost") or {})
                cost["total"] = 0.123
                usage["cost"] = cost
                return {"message": {**message, "usage": usage}}

            pi.on("message_end", on_message_end)
            """,
        )

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        model_registry = ModelRegistry.create(auth_storage)
        settings_manager = SettingsManager.create(str(tmp_path))

        message_end_events: list[dict] = []

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                agent_dir=str(tmp_path / "agent"),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=settings_manager,
                no_tools="all",
            )
        )
        session = result.session
        await session.bind_extensions()
        session.subscribe(
            lambda event: message_end_events.append(event)
            if event.get("type") == "message_end"
            else None
        )

        await session.prompt("hi")

        assistant = next(
            (message for message in session.messages if message.get("role") == "assistant"),
            None,
        )
        assert assistant is not None
        assert assistant["usage"]["cost"]["total"] == 0.123

        assistant_end = next(
            (
                event
                for event in message_end_events
                if event.get("message", {}).get("role") == "assistant"
            ),
            None,
        )
        assert assistant_end is not None
        assert assistant_end["message"]["usage"]["cost"]["total"] == 0.123
    finally:
        faux.set_responses([])
