"""Skill loading utilities for agent harness."""

import fnmatch
import os
import yaml
from dataclasses import dataclass
from typing import Any, TypeVar

from pi_mono.agent.harness.types import (
    ExecutionEnv,
    Skill,
    SkillDiagnostic,
    FileInfo,
)


MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"]


@dataclass
class SkillFrontmatter:
    name: str | None = None
    description: str | None = None
    disable_model_invocation: bool = False

    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k.replace("-", "_"), v)


def format_skill_invocation(skill: Skill, additional_instructions: str | None = None) -> str:
    """Format a skill invocation prompt, optionally appending additional user instructions."""
    skill_block = (
        f'<skill name="{skill.name}" location="{skill.file_path}">\n'
        f"References are relative to {_dirname_env_path(skill.file_path)}.\n\n"
        f"{skill.content}\n</skill>"
    )
    if additional_instructions:
        return f"{skill_block}\n\n{additional_instructions}"
    return skill_block


def _is_ignored(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if fnmatch.fnmatch(path, pattern):
            return True
    return False


class IgnoreMatcher:
    """Simple ignore pattern matcher using fnmatch."""

    def __init__(self):
        self.patterns: list[str] = []

    def add(self, patterns: list[str]) -> None:
        self.patterns.extend(patterns)

    def ignores(self, path: str) -> bool:
        return _is_ignored(path, self.patterns)


async def load_skills(
    env: ExecutionEnv,
    dirs: str | list[str],
) -> dict[str, list]:
    """Load skills from one or more directories."""
    skills: list[Skill] = []
    diagnostics: list[SkillDiagnostic] = []

    for dir_path in [dirs] if isinstance(dirs, str) else dirs:
        root_info_result = await env.file_info(dir_path)
        if not root_info_result.ok:
            if root_info_result.error.code != "not_found":
                diagnostics.append(
                    SkillDiagnostic(
                        type="warning",
                        code="file_info_failed",
                        message=root_info_result.error.message,
                        path=dir_path,
                    )
                )
            continue

        root_info = root_info_result.value
        if (await _resolve_kind(env, root_info, diagnostics)) != "directory":
            continue

        result = await _load_skills_from_dir_internal(
            env, root_info.path, True, IgnoreMatcher(), root_info.path
        )
        skills.extend(result[0])
        diagnostics.extend(result[1])

    return {"skills": skills, "diagnostics": diagnostics}


TSource = TypeVar("TSource")
TSkill = TypeVar("TSkill", bound="Skill")


async def load_sourced_skills(
    env: ExecutionEnv,
    inputs: list[dict[str, Any]],
    map_skill: Any = None,
) -> dict[str, list[Any]]:
    """Load skills from source-tagged directories."""
    skills: list[dict] = []
    diagnostics: list[dict] = []

    for input_item in inputs:
        result = await load_skills(env, input_item["path"])
        for skill in result["skills"]:
            skills.append(
                {
                    "skill": map_skill(skill, input_item["source"]) if map_skill else skill,
                    "source": input_item["source"],
                }
            )
        for diag in result["diagnostics"]:
            diagnostics.append(
                {
                    "type": diag.type,
                    "code": diag.code,
                    "message": diag.message,
                    "path": diag.path,
                    "source": input_item["source"],
                }
            )

    return {"skills": skills, "diagnostics": diagnostics}


def _dirname_env_path(path: str) -> str:
    normalized = path.rstrip("/")
    slash_index = normalized.rfind("/")
    return "/" if slash_index <= 0 else normalized[:slash_index]


def _basename_env_path(path: str) -> str:
    normalized = path.rstrip("/")
    slash_index = normalized.rfind("/")
    return normalized if slash_index == -1 else normalized[slash_index + 1 :]


def _relative_env_path(root: str, path: str) -> str:
    normalized_root = root.rstrip("/")
    normalized_path = path.rstrip("/")
    if normalized_path == normalized_root:
        return ""
    if normalized_path.startswith(f"{normalized_root}/"):
        return normalized_path[len(normalized_root) + 1 :]
    return normalized_path.lstrip("/")


def _join_env_path(base: str, child: str) -> str:
    return f"{base.rstrip('/')}/{child.lstrip('/')}"


async def _resolve_kind(
    env: ExecutionEnv,
    info: FileInfo,
    diagnostics: list[SkillDiagnostic],
) -> str | None:
    if info.kind in ("file", "directory"):
        return info.kind
    canonical = await env.canonical_path(info.path)
    if not canonical.ok:
        if canonical.error.code != "not_found":
            diagnostics.append(
                SkillDiagnostic(
                    type="warning",
                    code="file_info_failed",
                    message=canonical.error.message,
                    path=info.path,
                )
            )
        return None
    target = await env.file_info(canonical.value)
    if not target.ok:
        if target.error.code != "not_found":
            diagnostics.append(
                SkillDiagnostic(
                    type="warning",
                    code="file_info_failed",
                    message=target.error.message,
                    path=info.path,
                )
            )
        return None
    return target.value.kind if target.value.kind in ("file", "directory") else None


async def _add_ignore_rules(
    env: ExecutionEnv,
    ig: IgnoreMatcher,
    dir_path: str,
    root_dir: str,
    diagnostics: list[SkillDiagnostic],
) -> None:
    relative_dir = _relative_env_path(root_dir, dir_path)
    prefix = f"{relative_dir}/" if relative_dir else ""

    for filename in IGNORE_FILE_NAMES:
        ignore_path = os.path.join(dir_path, filename)
        info_result = await env.file_info(ignore_path)
        if not info_result.ok:
            if info_result.error.code != "not_found":
                diagnostics.append(
                    SkillDiagnostic(
                        type="warning",
                        code="file_info_failed",
                        message=info_result.error.message,
                        path=ignore_path,
                    )
                )
            continue

        info = info_result.value
        if info.kind != "file":
            continue

        content_result = await env.read_text_file(ignore_path)
        if not content_result.ok:
            diagnostics.append(
                SkillDiagnostic(
                    type="warning",
                    code="read_failed",
                    message=content_result.error.message,
                    path=ignore_path,
                )
            )
            continue

        patterns = []
        for line in content_result.value.splitlines():
            prefixed = _prefix_ignore_pattern(line, prefix)
            if prefixed:
                patterns.append(prefixed)

        if patterns:
            # We need a simple ignore matcher that stores patterns
            pass


def _prefix_ignore_pattern(line: str, prefix: str) -> str | None:
    trimmed = line.strip()
    if not trimmed:
        return None
    if trimmed.startswith("#") and not trimmed.startswith("\\#"):
        return None

    pattern = line
    negated = False
    if pattern.startswith("!"):
        negated = True
        pattern = pattern[1:]
    elif pattern.startswith("\\!"):
        pattern = pattern[1:]
    if pattern.startswith("/"):
        pattern = pattern[1:]
    prefixed = f"{prefix}{pattern}" if prefix else pattern
    return f"!{prefixed}" if negated else prefixed


async def _load_skills_from_dir_internal(
    env: ExecutionEnv,
    dir_path: str,
    include_root_files: bool,
    ignore_matcher: Any,
    root_dir: str,
) -> tuple[list["Skill"], list["SkillDiagnostic"]]:
    skills: list["Skill"] = []
    diagnostics: list[SkillDiagnostic] = []

    dir_info_result = await env.file_info(dir_path)
    if not dir_info_result.ok:
        if dir_info_result.error.code != "not_found":
            diagnostics.append(
                SkillDiagnostic(
                    type="warning",
                    code="file_info_failed",
                    message=dir_info_result.error.message,
                    path=dir_path,
                )
            )
        return skills, diagnostics

    dir_info = dir_info_result.value
    if (await _resolve_kind(env, dir_info, diagnostics)) != "directory":
        return skills, diagnostics

    await _add_ignore_rules(env, None, dir_path, root_dir, diagnostics)

    # We'll use a simpler approach with os.listdir
    try:
        entries = os.listdir(dir_path)
    except OSError:
        return skills, diagnostics

    for entry in entries:
        if entry != "SKILL.md":
            continue

        full_path = os.path.join(dir_path, entry)
        if not os.path.isfile(full_path):
            continue

        # Simple ignore check - skip for now
        result = await _load_skill_from_file(env, full_path)
        if result["skill"]:
            skills.append(result["skill"])
        diagnostics.extend(result["diagnostics"])
        return skills, diagnostics

    for entry in sorted(os.listdir(dir_path)):
        if entry.startswith(".") or entry == "node_modules":
            continue

        full_path = os.path.join(dir_path, entry)
        if os.path.isdir(full_path):
            result = await _load_skills_from_dir_internal(env, full_path, False, None, root_dir)
            skills.extend(result[0])
            diagnostics.extend(result[1])
            continue

        if not include_root_files or not entry.endswith(".md"):
            continue

        result = await _load_skill_from_file(env, full_path)
        if result["skill"]:
            skills.append(result["skill"])
        diagnostics.extend(result["diagnostics"])

    return skills, diagnostics


async def _load_skill_from_file(
    env: ExecutionEnv,
    file_path: str,
) -> dict[str, Any]:
    diagnostics: list[SkillDiagnostic] = []

    try:
        content_res = await env.read_text_file(file_path)
        if not content_res.ok:
            diagnostics.append(
                SkillDiagnostic(
                    type="warning",
                    code="read_failed",
                    message=content_res.error.message,
                    path=file_path,
                )
            )
            return {"skill": None, "diagnostics": diagnostics}
        raw_content = content_res.value
    except Exception as e:
        diagnostics.append(
            SkillDiagnostic(
                type="warning",
                code="read_failed",
                message=str(e),
                path=file_path,
            )
        )
        return {"skill": None, "diagnostics": diagnostics}

    try:
        parsed = _parse_frontmatter(raw_content)
        if not parsed:
            diagnostics.append(
                SkillDiagnostic(
                    type="warning",
                    code="parse_failed",
                    message="Failed to parse frontmatter",
                    path=file_path,
                )
            )
            return {"skill": None, "diagnostics": diagnostics}
        frontmatter, body = parsed
    except Exception as e:
        diagnostics.append(
            SkillDiagnostic(
                type="warning",
                code="parse_failed",
                message=str(e),
                path=file_path,
            )
        )
        return {"skill": None, "diagnostics": diagnostics}

    skill_dir = _dirname_env_path(file_path)
    parent_dir_name = _basename_env_path(skill_dir)
    description = frontmatter.get("description")

    for error in _validate_description(description):
        diagnostics.append(
            SkillDiagnostic(
                type="warning",
                code="invalid_metadata",
                message=error,
                path=file_path,
            )
        )

    frontmatter_name = frontmatter.get("name")
    name = frontmatter_name or parent_dir_name

    for error in _validate_name(name, parent_dir_name):
        diagnostics.append(
            SkillDiagnostic(
                type="warning",
                code="invalid_metadata",
                message=error,
                path=file_path,
            )
        )

    if not description or not description.strip():
        return {"skill": None, "diagnostics": diagnostics}

    return {
        "skill": Skill(
            name=name,
            description=description,
            content=body,
            file_path=file_path,
            disable_model_invocation=frontmatter.get(
                "disable-model-invocation", frontmatter.get("disable_model_invocation", False)
            ),
        ),
        "diagnostics": diagnostics,
    }


def _validate_name(name: str, parent_dir_name: str) -> list[str]:
    errors = []
    if name != parent_dir_name:
        errors.append(f'name "{name}" does not match parent directory "{parent_dir_name}"')
    if len(name) > MAX_NAME_LENGTH:
        errors.append(f"name exceeds {MAX_NAME_LENGTH} characters ({len(name)})")
    if not name.replace("-", "").replace("_", "").isalnum():
        errors.append("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)")
    if name.startswith("-") or name.endswith("-"):
        errors.append("name must not start or end with a hyphen")
    if "--" in name:
        errors.append("name must not contain consecutive hyphens")
    return errors


def _validate_description(description: str | None) -> list[str]:
    errors = []
    if not description or not description.strip():
        errors.append("description is required")
    elif len(description) > MAX_DESCRIPTION_LENGTH:
        errors.append(
            f"description exceeds {MAX_DESCRIPTION_LENGTH} characters ({len(description)})"
        )
    return errors


def _parse_frontmatter(content: str) -> tuple[dict, str] | None:
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---"):
        return {}, normalized

    end_index = normalized.find("\n---", 3)
    if end_index == -1:
        return {}, normalized

    yaml_string = normalized[4:end_index]
    body = normalized[end_index + 4 :].strip()
    frontmatter = yaml.safe_load(yaml_string) or {}
    return frontmatter, body


loadSkills = load_skills
loadSourcedSkills = load_sourced_skills
formatSkillInvocation = format_skill_invocation
