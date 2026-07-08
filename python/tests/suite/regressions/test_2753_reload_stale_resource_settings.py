"""Issue #2753: reload applies updated prompt settings after startup."""

from __future__ import annotations

import json
import os

import pytest

from pi_mono.ai.providers.faux import register_faux_provider
from pi_mono.coding_agent.core.sdk import CreateAgentSessionOptions, create_agent_session
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import SessionManager
from pi_mono.core.settings_manager import SettingsManager


@pytest.mark.anyio
async def test_applies_updated_top_level_prompt_settings_on_reload_after_startup(tmp_path) -> None:
    cwd = str(tmp_path)
    agent_dir = os.path.join(cwd, "agent")
    prompts_dir = os.path.join(agent_dir, "prompts")
    os.makedirs(prompts_dir, exist_ok=True)
    with open(os.path.join(prompts_dir, "test.md"), "w", encoding="utf-8") as handle:
        handle.write("Echo test prompt\n")

    faux = register_faux_provider({"models": [{"id": "faux-1", "reasoning": False}]})
    try:
        model = faux.get_model()
        assert model is not None
        auth_storage = AuthStorage.create()
        auth_storage.set_runtime_api_key(model["provider"], "faux-key")
        model_registry = ModelRegistry.create(auth_storage)
        settings_manager = SettingsManager.create(cwd, agent_dir)

        result = await create_agent_session(
            CreateAgentSessionOptions(
                cwd=cwd,
                agent_dir=agent_dir,
                model=model,
                auth_storage=auth_storage,
                model_registry=model_registry,
                settings_manager=settings_manager,
                session_manager=SessionManager.create(cwd),
                no_extensions=True,
                no_tools="all",
            )
        )
        session = result.session
        await session.bind_extensions(no_extensions=True)

        assert "test" in [prompt.name for prompt in session.prompt_templates]

        settings_path = os.path.join(agent_dir, "settings.json")
        with open(settings_path, "w", encoding="utf-8") as handle:
            json.dump({"prompts": ["-prompts/test.md"]}, handle, indent=2)
            handle.write("\n")

        await session.reload()

        assert settings_manager.get_global_settings().get("prompts") == ["-prompts/test.md"]
        assert "test" not in [prompt.name for prompt in session.prompt_templates]
    finally:
        faux.unregister()
