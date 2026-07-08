"""Regression #5596: export uses active fallback theme when configured theme is missing."""

from __future__ import annotations

import os

import pytest

from pi_mono.ai.providers.faux import faux_assistant_message, register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


@pytest.mark.anyio
async def test_exports_with_fallback_theme_when_configured_theme_is_missing(tmp_path) -> None:
    faux = register_faux_provider({"models": [{"id": "faux-1", "reasoning": False}]})
    try:
        faux.set_responses([faux_assistant_message("hello")])
        model = faux.get_model()
        assert model is not None

        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key(model["provider"], "faux-key")
        model_registry = ModelRegistry.create(auth_storage)
        settings_manager = SettingsManager.in_memory({"theme": "missing-theme"})

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=str(tmp_path),
                agent_dir=str(tmp_path / "agent"),
                session_manager=SessionManager.create(str(tmp_path), str(tmp_path / "sessions")),
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=settings_manager,
                no_tools="all",
                no_extensions=True,
            )
        )
        session = result.session
        await session.bind_extensions(no_extensions=True)
        await session.prompt("hi")
        init_theme(settings_manager.get_theme())

        output_path = os.path.join(str(tmp_path), "export.html")
        exported = await session.export_to_html(output_path)
        assert exported == output_path
        assert os.path.exists(output_path)
        assert settings_manager.get_theme() == "missing-theme"
    finally:
        faux.unregister()
        init_theme("dark")
