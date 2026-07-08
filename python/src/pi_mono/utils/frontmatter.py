"""YAML frontmatter parsing utilities."""

from __future__ import annotations

from typing import TypeVar

import yaml

T = TypeVar("T", bound=dict[str, object])


def _normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _extract_frontmatter(content: str) -> tuple[str | None, str]:
    normalized = _normalize_newlines(content)

    if not normalized.startswith("---"):
        return None, normalized

    end_index = normalized.find("\n---", 3)
    if end_index == -1:
        return None, normalized

    return normalized[4:end_index], normalized[end_index + 4 :].strip()


def parse_frontmatter(content: str) -> dict[str, object]:
    yaml_string, body = _extract_frontmatter(content)
    if not yaml_string:
        return {"frontmatter": {}, "body": body}
    parsed = yaml.safe_load(yaml_string)
    return {"frontmatter": parsed if isinstance(parsed, dict) else {}, "body": body}


def strip_frontmatter(content: str) -> str:
    return str(parse_frontmatter(content)["body"])
