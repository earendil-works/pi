#!/usr/bin/env python3
"""
Minimal validator for nanobot skill folders.
"""

import re
import sys
from pathlib import Path
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_FRONTMATTER_KEYS = {
    "name",
    "description",
    "metadata",
    "always",
    "license",
    "allowed-tools",
}
ALLOWED_RESOURCE_DIRS = {"scripts", "references", "assets"}
PLACEHOLDER_MARKERS = ("[todo", "todo:")


def _extract_frontmatter(content: str) -> Optional[str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i])
    return None


def _parse_simple_frontmatter(frontmatter_text: str) -> Optional[dict[str, str]]:
    """Fallback parser for simple frontmatter when PyYAML is unavailable."""
    parsed: dict[str, str] = {}
    current_key: Optional[str] = None
    multiline_key: Optional[str] = None

    for raw_line in frontmatter_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        is_indented = raw_line[:1].isspace()
        if is_indented:
            if current_key is None:
                return None
            current_value = parsed[current_key]
            parsed[current_key] = f"{current_value}\n{stripped}" if current_value else stripped
            continue

        if ":" not in stripped:
            return None

        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            return None

        if value in {"|", ">"}:
            parsed[key] = ""
            current_key = key
            multiline_key = key
            continue

        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        parsed[key] = value
        current_key = key
        multiline_key = None

    if multiline_key is not None and multiline_key not in parsed:
        return None
    return parsed


def _load_frontmatter(frontmatter_text: str) -> tuple[Optional[dict], Optional[str]]:
    if yaml is not None:
        try:
            frontmatter = yaml.safe_load(frontmatter_text)
        except yaml.YAMLError as exc:
            return None, f"Invalid YAML in frontmatter: {exc}"
        if not isinstance(frontmatter, dict):
            return None, "Frontmatter must be a YAML dictionary"
        return frontmatter, None

    frontmatter = _parse_simple_frontmatter(frontmatter_text)
    if frontmatter is None:
        return None, "Invalid YAML in frontmatter: unsupported syntax without PyYAML installed"
    return frontmatter, None


def _validate_skill_name(name: str, folder_name: str) -> Optional[str]:
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        return (
            f"Name '{name}' should be hyphen-case "
            "(lowercase letters, digits, and single hyphens only)"
        )
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return (
            f"Name is too long ({len(name)} characters). "
            f"Maximum is {MAX_SKILL_NAME_LENGTH} characters."
        )
    if name != folder_name:
        return f"Skill name '{name}' must match directory name '{folder_name}'"
    return None


def _validate_description(description: str) -> Optional[str]:
    trimmed = description.strip()
    if not trimmed:
        return "Description cannot be empty"
    lowered = trimmed.lower()
    if any(marker in lowered for marker in PLACEHOLDER_MARKERS):
        return "Description still contains TODO placeholder text"
    if "<" in trimmed or ">" in trimmed:
        return "Description cannot contain angle brackets (< or >)"
    if len(trimmed) > 1024:
        return f"Description is too long ({len(trimmed)} characters). Maximum is 1024 characters."
    return None


def validate_skill(skill_path):
    """Validate a skill folder structure and required frontmatter."""
    skill_path = Path(skill_path).resolve()

    if not skill_path.exists():
        return False, f"Skill folder not found: {skill_path}"
    if not skill_path.is_dir():
        return False, f"Path is not a directory: {skill_path}"

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as exc:
        return False, f"Could not read SKILL.md: {exc}"

    frontmatter_text = _extract_frontmatter(content)
    if frontmatter_text is None:
        return False, "Invalid frontmatter format"

    frontmatter, error = _load_frontmatter(frontmatter_text)
    if error:
        return False, error

    unexpected_keys = sorted(set(frontmatter.keys()) - ALLOWED_FRONTMATTER_KEYS)
    if unexpected_keys:
        allowed = ", ".join(sorted(ALLOWED_FRONTMATTER_KEYS))
        unexpected = ", ".join(unexpected_keys)
        return (
            False,
            f"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}",
        )

    if "name" not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if "description" not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    name = frontmatter["name"]
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name_error = _validate_skill_name(name.strip(), skill_path.name)
    if name_error:
        return False, name_error

    description = frontmatter["description"]
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description_error = _validate_description(description)
    if description_error:
        return False, description_error

    always = frontmatter.get("always")
    if always is not None and not isinstance(always, bool):
        return False, f"'always' must be a boolean, got {type(always).__name__}"

    for child in skill_path.iterdir():
        if child.name == "SKILL.md":
            continue
        if child.is_dir() and child.name in ALLOWED_RESOURCE_DIRS:
            continue
        if child.is_symlink():
            continue
        return (
            False,
            f"Unexpected file or directory in skill root: {child.name}. "
            "Only SKILL.md, scripts/, references/, and assets/ are allowed.",
        )

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
