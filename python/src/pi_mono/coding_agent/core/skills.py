"""Thin wrapper over agent harness skill loading."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from pi_mono.agent.harness import skills as _harness_skills
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.types import Skill
from pi_mono.config import CONFIG_DIR_NAME
from pi_mono.utils.paths import resolve_path

load_skills = _harness_skills.load_skills
load_sourced_skills = _harness_skills.load_sourced_skills
format_skill_invocation = _harness_skills.format_skill_invocation
SkillFrontmatter = _harness_skills.SkillFrontmatter


async def load_configured_skills(
    *,
    cwd: str,
    agent_dir: str,
    skill_paths: list[str],
    include_defaults: bool = False,
) -> dict[str, list[Any]]:
    """Load skills from configured paths with name-collision diagnostics."""
    resolved_cwd = resolve_path(cwd)
    resolved_agent_dir = resolve_path(agent_dir)
    env = LocalExecutionEnv(cwd=resolved_cwd)

    skill_map: dict[str, Skill] = {}
    real_paths: set[str] = set()
    all_diagnostics: list[dict[str, Any]] = []
    collision_diagnostics: list[dict[str, Any]] = []

    def add_skills(result: dict[str, list[Any]]) -> None:
        for diagnostic in result.get("diagnostics", []):
            all_diagnostics.append(
                {
                    "type": getattr(diagnostic, "type", diagnostic.get("type")),
                    "message": getattr(diagnostic, "message", diagnostic.get("message")),
                    "path": getattr(diagnostic, "path", diagnostic.get("path")),
                }
            )
        for skill in result.get("skills", []):
            real_path = os.path.realpath(skill.file_path)
            if real_path in real_paths:
                continue
            existing = skill_map.get(skill.name)
            if existing is not None:
                collision_diagnostics.append(
                    {
                        "type": "collision",
                        "message": f'name "{skill.name}" collision',
                        "path": skill.file_path,
                        "collision": {
                            "resourceType": "skill",
                            "name": skill.name,
                            "winnerPath": existing.file_path,
                            "loserPath": skill.file_path,
                        },
                    }
                )
            else:
                skill_map[skill.name] = skill
                real_paths.add(real_path)

    if include_defaults:
        user_dir = os.path.join(resolved_agent_dir, "skills")
        project_dir = os.path.join(resolved_cwd, CONFIG_DIR_NAME, "skills")
        add_skills(await load_skills(env, user_dir))
        add_skills(await load_skills(env, project_dir))

    for raw_path in skill_paths:
        resolved_path = resolve_path(raw_path, resolved_cwd)
        if not os.path.exists(resolved_path):
            all_diagnostics.append(
                {
                    "type": "warning",
                    "message": "skill path does not exist",
                    "path": resolved_path,
                }
            )
            continue
        try:
            if os.path.isdir(resolved_path):
                add_skills(await load_skills(env, resolved_path))
            elif os.path.isfile(resolved_path) and resolved_path.endswith(".md"):
                parent_name = os.path.basename(os.path.dirname(resolved_path))
                single_result = await load_skills(env, os.path.dirname(resolved_path))
                matched = [
                    skill
                    for skill in single_result.get("skills", [])
                    if os.path.realpath(skill.file_path) == os.path.realpath(resolved_path)
                ]
                if matched:
                    add_skills({"skills": matched, "diagnostics": single_result.get("diagnostics", [])})
                else:
                    all_diagnostics.append(
                        {
                            "type": "warning",
                            "message": f"skill file {parent_name} could not be loaded",
                            "path": resolved_path,
                        }
                    )
            else:
                all_diagnostics.append(
                    {
                        "type": "warning",
                        "message": "skill path is not a markdown file",
                        "path": resolved_path,
                    }
                )
        except OSError as error:
            all_diagnostics.append(
                {
                    "type": "warning",
                    "message": str(error),
                    "path": resolved_path,
                }
            )

    return {
        "skills": list(skill_map.values()),
        "diagnostics": [*all_diagnostics, *collision_diagnostics],
    }


def map_skill_path(path: str, metadata: dict[str, Any]) -> str:
    """Map auto-discovered or package skill directories to SKILL.md when present."""
    if metadata.get("source") != "auto" and metadata.get("origin") != "package":
        return path
    if not os.path.isdir(path):
        return path
    skill_file = os.path.join(path, "SKILL.md")
    return skill_file if os.path.isfile(skill_file) else path


def expand_skill_command(
    text: str,
    skills: list[Skill],
    *,
    emit_error: Callable[[str, str], None] | None = None,
) -> str:
    """Expand /skill:name commands to skill blocks, matching TypeScript behavior."""
    if not text.startswith("/skill:"):
        return text

    space_index = text.find(" ")
    skill_name = text[7:space_index] if space_index != -1 else text[7:]
    args = text[space_index + 1 :].strip() if space_index != -1 else ""

    skill = next((item for item in skills if item.name == skill_name), None)
    if skill is None:
        return text

    try:
        return format_skill_invocation(skill, args or None)
    except Exception as error:
        if emit_error is not None:
            emit_error(skill.file_path, str(error))
        return text


__all__ = [
    "expand_skill_command",
    "format_skill_invocation",
    "load_configured_skills",
    "load_skills",
    "load_sourced_skills",
    "map_skill_path",
    "SkillFrontmatter",
]
