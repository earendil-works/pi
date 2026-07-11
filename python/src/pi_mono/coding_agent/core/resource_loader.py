"""Resource loading for skills, prompt templates, and context files."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.prompt_templates import load_prompt_templates
from pi_mono.agent.harness.skills import load_skills
from pi_mono.agent.harness.types import PromptTemplate, Skill
from pi_mono.coding_agent.core.extensions.loader import (
    collect_configured_extension_paths,
    create_extension_runtime,
    discover_and_load_extensions,
)
from pi_mono.coding_agent.core.extensions.types import LoadExtensionsResult
from pi_mono.coding_agent.core.package_manager import (
    DefaultPackageManager,
    _apply_pattern_entries,
    _collect_files_from_path,
)
from pi_mono.coding_agent.core.skills import load_configured_skills, map_skill_path
from pi_mono.config import CONFIG_DIR_NAME
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.utils.paths import resolve_path


ResourceDiagnostic = dict[str, Any]


def _empty_extensions_result() -> LoadExtensionsResult:
    return LoadExtensionsResult(
        extensions=[],
        errors=[],
        runtime=create_extension_runtime(),
    )


def _resolve_prompt_input(input_value: str | None, description: str) -> str | None:
    if not input_value:
        return None
    if os.path.exists(input_value):
        try:
            return Path(input_value).read_text(encoding="utf-8")
        except OSError as error:
            print(f"Warning: Could not read {description} file {input_value}: {error}")
            return input_value
    return input_value


def _load_context_file_from_dir(directory: str) -> dict[str, str] | None:
    for filename in ("AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"):
        file_path = os.path.join(directory, filename)
        if os.path.exists(file_path):
            try:
                return {"path": file_path, "content": Path(file_path).read_text(encoding="utf-8")}
            except OSError as error:
                print(f"Warning: Could not read {file_path}: {error}")
    return None


def load_project_context_files(*, cwd: str, agent_dir: str) -> list[dict[str, str]]:
    resolved_cwd = resolve_path(cwd)
    resolved_agent_dir = resolve_path(agent_dir)
    context_files: list[dict[str, str]] = []
    seen_paths: set[str] = set()

    global_context = _load_context_file_from_dir(resolved_agent_dir)
    if global_context:
        context_files.append(global_context)
        seen_paths.add(global_context["path"])

    ancestor_context_files: list[dict[str, str]] = []
    current_dir = resolved_cwd
    root = os.path.abspath(os.sep)

    while True:
        context_file = _load_context_file_from_dir(current_dir)
        if context_file and context_file["path"] not in seen_paths:
            ancestor_context_files.insert(0, context_file)
            seen_paths.add(context_file["path"])

        if current_dir == root:
            break
        parent_dir = os.path.abspath(os.path.join(current_dir, os.pardir))
        if parent_dir == current_dir:
            break
        current_dir = parent_dir

    context_files.extend(ancestor_context_files)
    return context_files


class ResourceLoader(Protocol):
    def get_extensions(self) -> LoadExtensionsResult: ...

    def get_skills(self) -> dict[str, list[Any]]: ...

    def get_prompts(self) -> dict[str, list[Any]]: ...

    def get_agents_files(self) -> dict[str, list[dict[str, str]]]: ...

    def get_system_prompt(self) -> str | None: ...

    def get_append_system_prompt(self) -> list[str]: ...

    async def reload(self) -> None: ...


@dataclass
class DefaultResourceLoaderOptions:
    cwd: str
    agent_dir: str
    settings_manager: SettingsManager | None = None
    additional_skill_paths: list[str] | None = None
    additional_prompt_template_paths: list[str] | None = None
    additional_extension_paths: list[str] | None = None
    no_skills: bool = False
    no_prompt_templates: bool = False
    no_extensions: bool = False
    no_context_files: bool = False
    system_prompt: str | None = None
    append_system_prompt: list[str] | None = None


class DefaultResourceLoader:
    """Basic resource loader for skills, prompt templates, and context files."""

    def __init__(self, options: DefaultResourceLoaderOptions) -> None:
        self._cwd = resolve_path(options.cwd)
        self._agent_dir = resolve_path(options.agent_dir)
        self._settings_manager = options.settings_manager or SettingsManager.create(
            self._cwd, self._agent_dir
        )
        self._additional_skill_paths = list(options.additional_skill_paths or [])
        self._additional_prompt_paths = list(options.additional_prompt_template_paths or [])
        self._additional_extension_paths = list(options.additional_extension_paths or [])
        self._no_skills = options.no_skills
        self._no_prompt_templates = options.no_prompt_templates
        self._no_extensions = options.no_extensions
        self._no_context_files = options.no_context_files
        self._system_prompt_source = options.system_prompt
        self._append_system_prompt_source = options.append_system_prompt

        self._extensions_result = _empty_extensions_result()
        self._skills: list[Skill] = []
        self._skill_diagnostics: list[ResourceDiagnostic] = []
        self._prompts: list[PromptTemplate] = []
        self._prompt_diagnostics: list[ResourceDiagnostic] = []
        self._agents_files: list[dict[str, str]] = []
        self._system_prompt: str | None = None
        self._append_system_prompt: list[str] = []

    def get_extensions(self) -> LoadExtensionsResult:
        return self._extensions_result

    def get_skills(self) -> dict[str, list[Any]]:
        return {"skills": self._skills, "diagnostics": self._skill_diagnostics}

    def get_prompts(self) -> dict[str, list[Any]]:
        return {"prompts": self._prompts, "diagnostics": self._prompt_diagnostics}

    def get_agents_files(self) -> dict[str, list[dict[str, str]]]:
        return {"agentsFiles": self._agents_files}

    def get_system_prompt(self) -> str | None:
        return self._system_prompt

    def get_append_system_prompt(self) -> list[str]:
        return list(self._append_system_prompt)

    async def reload(self) -> None:
        await self._settings_manager.reload()
        env = LocalExecutionEnv(cwd=self._cwd)

        if self._no_extensions:
            self._extensions_result = _empty_extensions_result()
        else:
            extension_paths = await collect_configured_extension_paths(
                self._cwd,
                self._agent_dir,
                self._settings_manager,
                self._additional_extension_paths,
            )
            self._extensions_result = await discover_and_load_extensions(
                extension_paths,
                self._cwd,
                self._agent_dir,
            )

        skill_paths = self._merge_paths(
            (
                []
                if self._no_skills
                else await self._resolve_skill_paths()
            ),
            self._additional_skill_paths,
        )
        if skill_paths:
            skills_result = await load_configured_skills(
                cwd=self._cwd,
                agent_dir=self._agent_dir,
                skill_paths=skill_paths,
                include_defaults=False,
            )
            self._skills = skills_result["skills"]
            self._skill_diagnostics = list(skills_result["diagnostics"])
        else:
            self._skills = []
            self._skill_diagnostics = []

        prompt_paths = self._merge_paths(
            (
                []
                if self._no_prompt_templates
                else [
                    os.path.join(self._agent_dir, "prompts"),
                    os.path.join(self._cwd, CONFIG_DIR_NAME, "prompts"),
                ]
            ),
            self._additional_prompt_paths,
        )
        if prompt_paths:
            all_prompt_files: list[str] = []
            for path in prompt_paths:
                all_prompt_files.extend(_collect_files_from_path(path, "prompts"))
            patterns = self._settings_manager.get_prompt_template_paths()
            if patterns:
                enabled_files = sorted(
                    _apply_pattern_entries(all_prompt_files, patterns, self._agent_dir)
                )
            else:
                enabled_files = sorted(all_prompt_files)
            if enabled_files:
                prompts_result = await load_prompt_templates(env, enabled_files)
                self._prompts = prompts_result["prompt_templates"]
                self._prompt_diagnostics = [
                    {
                        "type": diagnostic.type,
                        "message": diagnostic.message,
                        "path": diagnostic.path,
                    }
                    for diagnostic in prompts_result["diagnostics"]
                ]
            else:
                self._prompts = []
                self._prompt_diagnostics = []
        else:
            self._prompts = []
            self._prompt_diagnostics = []

        self._agents_files = (
            []
            if self._no_context_files
            else load_project_context_files(cwd=self._cwd, agent_dir=self._agent_dir)
        )

        base_system_prompt = _resolve_prompt_input(
            self._system_prompt_source or self._discover_system_prompt_file(),
            "system prompt",
        )
        self._system_prompt = base_system_prompt

        append_sources = self._append_system_prompt_source or []
        discovered_append = self._discover_append_system_prompt_file()
        if discovered_append:
            append_sources = append_sources or [discovered_append]
        self._append_system_prompt = [
            value
            for value in (
                _resolve_prompt_input(source, "append system prompt") for source in append_sources
            )
            if value is not None
        ]

    def _discover_system_prompt_file(self) -> str | None:
        for candidate in (
            os.path.join(self._cwd, CONFIG_DIR_NAME, "SYSTEM.md"),
            os.path.join(self._agent_dir, "SYSTEM.md"),
        ):
            if os.path.exists(candidate):
                return candidate
        return None

    def _discover_append_system_prompt_file(self) -> str | None:
        for candidate in (
            os.path.join(self._cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md"),
            os.path.join(self._agent_dir, "APPEND_SYSTEM.md"),
        ):
            if os.path.exists(candidate):
                return candidate
        return None

    async def _resolve_skill_paths(self) -> list[str]:
        package_manager = DefaultPackageManager(
            cwd=self._cwd,
            agent_dir=self._agent_dir,
            settings_manager=self._settings_manager,
        )
        resolved = await package_manager.resolve()
        skill_paths: list[str] = []
        for resource in resolved["skills"]:
            if not resource.get("enabled", True):
                continue
            metadata = resource.get("metadata", {})
            skill_paths.append(map_skill_path(resource["path"], metadata))
        return skill_paths

    def _merge_paths(self, primary: list[str], additional: list[str]) -> list[str]:
        merged: list[str] = []
        seen: set[str] = set()
        for path in [*primary, *additional]:
            resolved = resolve_path(path, self._cwd)
            if resolved in seen:
                continue
            seen.add(resolved)
            merged.append(resolved)
        return merged
