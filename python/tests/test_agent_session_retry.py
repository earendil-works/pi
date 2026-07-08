import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


@pytest.mark.anyio
async def test_agent_session_retries_transient_error(tmp_path):
    faux = register_faux_provider({"provider": "faux", "api": "faux"})
    try:
        faux.set_responses(
            [
                faux_assistant_message(
                    "", options={"stopReason": "error", "errorMessage": "overloaded_error"}
                ),
                faux_assistant_message("recovered"),
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
        retry_events: list[str] = []

        def on_event(event):
            event_type = event.get("type")
            if event_type == "auto_retry_start":
                retry_events.append(f"start:{event.get('attempt')}")
            elif event_type == "auto_retry_end":
                retry_events.append(f"end:{event.get('success')}")

        session.subscribe(on_event)
        await session.prompt("test")

        assert retry_events == ["start:1", "end:True"]
        assistant_texts = [
            block.get("text", "")
            for message in session.agent.state.messages
            if message.get("role") == "assistant"
            for block in message.get("content", [])
            if block.get("type") == "text"
        ]
        assert any("recovered" in text for text in assistant_texts)
        assert faux.state["callCount"] == 2
    finally:
        faux.unregister()
