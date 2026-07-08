"""Issue #3616: in-memory settings survive reload."""

from __future__ import annotations

import os

import pytest

from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
)
from pi_mono.core.settings_manager import SettingsManager


@pytest.mark.anyio
async def test_preserves_initial_settings_after_direct_reload() -> None:
    settings_manager = SettingsManager.in_memory(
        {
            "defaultThinkingLevel": "high",
            "images": {"autoResize": False},
            "compaction": {"enabled": False},
        }
    )

    await settings_manager.reload()

    assert settings_manager.get_default_thinking_level() == "high"
    assert settings_manager.get_image_auto_resize() is False
    assert settings_manager.get_compaction_enabled() is False
    assert settings_manager.get_global_settings() == {
        "defaultThinkingLevel": "high",
        "images": {"autoResize": False},
        "compaction": {"enabled": False},
    }


@pytest.mark.anyio
async def test_preserves_initial_settings_when_resource_loader_reloads(tmp_path) -> None:
    cwd = str(tmp_path)
    agent_dir = os.path.join(cwd, "agent")
    os.makedirs(agent_dir, exist_ok=True)
    settings_manager = SettingsManager.in_memory(
        {
            "defaultThinkingLevel": "high",
            "images": {"autoResize": False},
            "compaction": {"enabled": False},
        }
    )
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd,
            agent_dir=agent_dir,
            settings_manager=settings_manager,
            no_skills=True,
            no_prompt_templates=True,
            no_context_files=True,
        )
    )

    await resource_loader.reload()

    assert settings_manager.get_default_thinking_level() == "high"
    assert settings_manager.get_image_auto_resize() is False
    assert settings_manager.get_compaction_enabled() is False


@pytest.mark.anyio
async def test_preserves_initial_settings_after_unrelated_setter_flush_and_reload() -> None:
    settings_manager = SettingsManager.in_memory(
        {
            "images": {"autoResize": False},
            "compaction": {"enabled": False},
        }
    )

    settings_manager.set_theme("dark")
    await settings_manager.flush()
    await settings_manager.reload()

    assert settings_manager.get_theme() == "dark"
    assert settings_manager.get_image_auto_resize() is False
    assert settings_manager.get_compaction_enabled() is False
    assert settings_manager.get_global_settings() == {
        "images": {"autoResize": False},
        "compaction": {"enabled": False},
        "theme": "dark",
    }
