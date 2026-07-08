"""Issue #3317: retry transient Network connection lost failures."""

from __future__ import annotations

import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


@pytest.mark.anyio
async def test_retries_transient_network_connection_lost_failures(tmp_path) -> None:
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        faux.set_responses(
            [
                faux_assistant_message(
                    "",
                    options={"stopReason": "error", "errorMessage": "Network connection lost."},
                ),
                faux_assistant_message("recovered after reconnect"),
            ]
        )
        model = faux.get_model()
        assert model is not None

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key("faux", "test-key")
        model_registry = ModelRegistry.create(auth_storage)
        settings_manager = SettingsManager.create(str(tmp_path))
        settings_manager.global_settings["retry"] = {
            "enabled": True,
            "maxRetries": 3,
            "baseDelayMs": 1,
        }
        settings_manager.save()

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                session_manager=SessionManager.in_memory(str(tmp_path)),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=settings_manager,
                no_extensions=True,
                no_tools="all",
            )
        )
        session = result.session
        retry_starts: list[str] = []
        retry_ends: list[bool] = []

        def on_event(event: dict) -> None:
            if event.get("type") == "auto_retry_start":
                retry_starts.append(str(event.get("errorMessage")))
            elif event.get("type") == "auto_retry_end":
                retry_ends.append(bool(event.get("success")))

        session.subscribe(on_event)
        await session.prompt("test")

        assert faux.state["callCount"] == 2
        assert retry_starts == ["Network connection lost."]
        assert retry_ends == [True]
        assistant_texts = [
            block.get("text", "")
            for message in session.agent.state.messages
            if message.get("role") == "assistant"
            for block in message.get("content", [])
            if block.get("type") == "text"
        ]
        assert any("recovered after reconnect" in text for text in assistant_texts)
    finally:
        faux.unregister()
