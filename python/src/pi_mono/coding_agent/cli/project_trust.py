"""CLI helpers for project trust resolution."""

from __future__ import annotations

from pi_mono.coding_agent.core.trust_manager import (
    ProjectTrustStore,
    has_trust_requiring_project_resources,
)
from pi_mono.core.settings_manager import SettingsManager


def bootstrap_project_trusted(
    *,
    cwd: str,
    agent_dir: str,
    trust_override: bool | None,
) -> bool:
    """Resolve trust from CLI override, store, or defaults (no interactive UI)."""
    if trust_override is not None:
        return trust_override
    if not has_trust_requiring_project_resources(cwd):
        return True
    store = ProjectTrustStore(agent_dir)
    stored = store.get(cwd)
    if stored is not None:
        return stored
    settings = SettingsManager.create(cwd, agent_dir, project_trusted=False)
    default = settings.get_default_project_trust()
    if default == "always":
        return True
    if default == "never":
        return False
    return False


def should_prompt_project_trust_in_interactive(
    *,
    cwd: str,
    agent_dir: str,
    trust_override: bool | None,
    project_trusted: bool,
) -> bool:
    if trust_override is not None:
        return False
    if project_trusted:
        return False
    if not has_trust_requiring_project_resources(cwd):
        return False
    store = ProjectTrustStore(agent_dir)
    if store.get(cwd) is not None:
        return False
    settings = SettingsManager.create(cwd, agent_dir, project_trusted=False)
    return settings.get_default_project_trust() == "ask"
