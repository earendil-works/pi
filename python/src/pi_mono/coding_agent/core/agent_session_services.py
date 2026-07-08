"""Cwd-bound runtime services for AgentSession creation."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from pi_mono.config import get_agent_dir
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.coding_agent.core.resource_loader import (
    DefaultResourceLoader,
    DefaultResourceLoaderOptions,
    ResourceLoader,
)
from pi_mono.utils.paths import resolve_path


AgentSessionRuntimeDiagnostic = dict[str, str]


@dataclass
class CreateAgentSessionServicesOptions:
    cwd: str
    agent_dir: str | None = None
    auth_storage: AuthStorage | None = None
    settings_manager: SettingsManager | None = None
    model_registry: ModelRegistry | None = None
    extension_flag_values: dict[str, bool | str] | None = None
    resource_loader_options: dict[str, Any] | None = None


@dataclass
class AgentSessionServices:
    cwd: str
    agent_dir: str
    auth_storage: AuthStorage
    settings_manager: SettingsManager
    model_registry: ModelRegistry
    resource_loader: ResourceLoader
    diagnostics: list[AgentSessionRuntimeDiagnostic] = field(default_factory=list)


def _apply_extension_flag_values(
    resource_loader: ResourceLoader,
    extension_flag_values: dict[str, bool | str] | None,
) -> list[AgentSessionRuntimeDiagnostic]:
    if not extension_flag_values:
        return []

    diagnostics: list[AgentSessionRuntimeDiagnostic] = []
    extensions_result = resource_loader.get_extensions()
    registered_flags: dict[str, dict[str, str]] = {}
    for extension in extensions_result.extensions:
        for name, flag in getattr(extension, "flags", {}).items():
            registered_flags[name] = {"type": flag.get("type", "boolean")}
        if isinstance(extension, dict):
            for name, flag in extension.get("flags", {}).items():
                registered_flags[name] = {"type": flag.get("type", "boolean")}

    unknown_flags: list[str] = []
    runtime = extensions_result.runtime
    flag_values = runtime.setdefault("flagValues", {})
    for name, value in extension_flag_values.items():
        flag = registered_flags.get(name)
        if not flag:
            unknown_flags.append(name)
            continue
        if flag["type"] == "boolean":
            flag_values[name] = True
            continue
        if isinstance(value, str):
            flag_values[name] = value
            continue
        diagnostics.append(
            {"type": "error", "message": f'Extension flag "--{name}" requires a value'}
        )

    if unknown_flags:
        suffix = "" if len(unknown_flags) == 1 else "s"
        joined = ", ".join(f"--{name}" for name in unknown_flags)
        diagnostics.append({"type": "error", "message": f"Unknown option{suffix}: {joined}"})

    return diagnostics


async def create_agent_session_services(
    options: CreateAgentSessionServicesOptions,
) -> AgentSessionServices:
    cwd = resolve_path(options.cwd)
    agent_dir = resolve_path(options.agent_dir) if options.agent_dir else str(get_agent_dir())
    auth_storage = options.auth_storage or AuthStorage.create(os.path.join(agent_dir, "auth.json"))
    settings_manager = options.settings_manager or SettingsManager.create(cwd, agent_dir)
    model_registry = options.model_registry or ModelRegistry.create(
        auth_storage, os.path.join(agent_dir, "models.json")
    )

    loader_options = dict(options.resource_loader_options or {})
    resource_loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(
            cwd=cwd,
            agent_dir=agent_dir,
            settings_manager=settings_manager,
            **loader_options,
        )
    )
    await resource_loader.reload()

    diagnostics: list[AgentSessionRuntimeDiagnostic] = []
    extensions_result = resource_loader.get_extensions()
    runtime = extensions_result.runtime
    pending = list(runtime.get("pendingProviderRegistrations", []))
    for registration in pending:
        try:
            model_registry.register_provider(registration["name"], registration["config"])
        except Exception as error:
            diagnostics.append(
                {
                    "type": "error",
                    "message": (
                        f'Extension "{registration.get("extensionPath", "unknown")}" error: {error}'
                    ),
                }
            )
    runtime["pendingProviderRegistrations"] = []
    diagnostics.extend(_apply_extension_flag_values(resource_loader, options.extension_flag_values))

    return AgentSessionServices(
        cwd=cwd,
        agent_dir=agent_dir,
        auth_storage=auth_storage,
        settings_manager=settings_manager,
        model_registry=model_registry,
        resource_loader=resource_loader,
        diagnostics=diagnostics,
    )
