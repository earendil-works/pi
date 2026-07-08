"""Persistent project trust decisions for cwd-scoped pi resources."""

from __future__ import annotations

import fcntl
import json
import os
from contextlib import contextmanager
from dataclasses import dataclass

from pi_mono.config import CONFIG_DIR_NAME
from pi_mono.utils.paths import canonicalize_path, resolve_path

ProjectTrustDecision = bool | None


@dataclass
class ProjectTrustStoreEntry:
    path: str
    decision: bool


@dataclass
class ProjectTrustUpdate:
    path: str
    decision: ProjectTrustDecision


@dataclass
class ProjectTrustOption:
    label: str
    trusted: bool
    updates: list[ProjectTrustUpdate]
    saved_path: str | None = None


TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = (
    "settings.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
)


def _normalize_cwd(cwd: str) -> str:
    return canonicalize_path(resolve_path(cwd))


def _find_nearest_trust_entry(
    data: dict[str, bool | None], cwd: str
) -> ProjectTrustStoreEntry | None:
    current_dir = _normalize_cwd(cwd)
    while True:
        value = data.get(current_dir)
        if value is True or value is False:
            return ProjectTrustStoreEntry(path=current_dir, decision=value)
        parent_dir = os.path.dirname(current_dir)
        if parent_dir == current_dir:
            return None
        current_dir = parent_dir


def get_project_trust_parent_path(cwd: str) -> str | None:
    trust_path = _normalize_cwd(cwd)
    parent_dir = os.path.dirname(trust_path)
    return None if parent_dir == trust_path else parent_dir


def get_project_trust_options(
    cwd: str, *, include_session_only: bool = False
) -> list[ProjectTrustOption]:
    trust_path = _normalize_cwd(cwd)
    options: list[ProjectTrustOption] = [
        ProjectTrustOption(
            label="Trust",
            trusted=True,
            updates=[ProjectTrustUpdate(path=trust_path, decision=True)],
            saved_path=trust_path,
        )
    ]
    parent_path = get_project_trust_parent_path(cwd)
    if parent_path is not None:
        options.append(
            ProjectTrustOption(
                label=f"Trust parent folder ({parent_path})",
                trusted=True,
                updates=[
                    ProjectTrustUpdate(path=parent_path, decision=True),
                    ProjectTrustUpdate(path=trust_path, decision=None),
                ],
                saved_path=parent_path,
            )
        )
    if include_session_only:
        options.append(
            ProjectTrustOption(label="Trust (this session only)", trusted=True, updates=[])
        )
    options.append(
        ProjectTrustOption(
            label="Do not trust",
            trusted=False,
            updates=[ProjectTrustUpdate(path=trust_path, decision=False)],
            saved_path=trust_path,
        )
    )
    if include_session_only:
        options.append(
            ProjectTrustOption(label="Do not trust (this session only)", trusted=False, updates=[])
        )
    return options


def _read_trust_file(path: str) -> dict[str, bool | None]:
    if not os.path.exists(path):
        return {}
    try:
        parsed = json.loads(open(path, encoding="utf-8").read())
    except Exception as error:
        raise ValueError(f"Failed to read trust store {path}: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"Invalid trust store {path}: expected an object")
    data: dict[str, bool | None] = {}
    for key, value in parsed.items():
        if value is not True and value is not False and value is not None:
            raise ValueError(
                f"Invalid trust store {path}: value for {json.dumps(key)} must be true, false, or null"
            )
        data[str(key)] = value
    return data


def _write_trust_file(path: str, data: dict[str, bool | None]) -> None:
    sorted_data: dict[str, bool | None] = {}
    for key in sorted(data):
        value = data[key]
        if value is True or value is False or value is None:
            sorted_data[key] = value
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(sorted_data, handle, indent=2)
        handle.write("\n")


@contextmanager
def _trust_file_lock(path: str):
    trust_dir = os.path.dirname(path)
    os.makedirs(trust_dir, exist_ok=True)
    lock_path = f"{path}.lock"
    with open(lock_path, "w", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def has_trust_requiring_project_resources(cwd: str) -> bool:
    home_dir = canonicalize_path(resolve_path(os.path.expanduser("~")))
    user_agents_skills_dir = os.path.join(home_dir, ".agents", "skills")
    current_dir = canonicalize_path(resolve_path(cwd))

    config_dir = os.path.join(current_dir, CONFIG_DIR_NAME)
    if any(
        os.path.exists(os.path.join(config_dir, entry))
        for entry in TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES
    ):
        return True

    while True:
        agents_skills_dir = os.path.join(current_dir, ".agents", "skills")
        if agents_skills_dir != user_agents_skills_dir and os.path.exists(agents_skills_dir):
            return True
        parent_dir = os.path.dirname(current_dir)
        if parent_dir == current_dir:
            return False
        current_dir = parent_dir


class ProjectTrustStore:
    def __init__(self, agent_dir: str) -> None:
        self.trust_path = os.path.join(resolve_path(agent_dir), "trust.json")

    def get(self, cwd: str) -> ProjectTrustDecision:
        entry = self.get_entry(cwd)
        return entry.decision if entry else None

    def get_entry(self, cwd: str) -> ProjectTrustStoreEntry | None:
        with _trust_file_lock(self.trust_path):
            data = _read_trust_file(self.trust_path)
            return _find_nearest_trust_entry(data, cwd)

    def set(self, cwd: str, decision: ProjectTrustDecision) -> None:
        self.set_many([ProjectTrustUpdate(path=cwd, decision=decision)])

    def set_many(self, decisions: list[ProjectTrustUpdate]) -> None:
        with _trust_file_lock(self.trust_path):
            data = _read_trust_file(self.trust_path)
            for item in decisions:
                key = _normalize_cwd(item.path)
                if item.decision is None:
                    data.pop(key, None)
                else:
                    data[key] = item.decision
            _write_trust_file(self.trust_path, data)
