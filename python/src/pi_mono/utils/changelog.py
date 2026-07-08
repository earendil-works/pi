"""Parse and filter CHANGELOG.md entries."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

GITHUB_REPO = "earendil-works/pi-mono"
CHANGELOG_LINK_BASE_PATH = "packages/coding-agent"
LEGACY_REPO_RE = re.compile(r"^https://github\.com/(?:badlogic|earendil-works)/pi-mono(?=/|$)")
URL_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
INLINE_MARKDOWN_LINK_RE = re.compile(r"(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))")


@dataclass(frozen=True)
class ChangelogEntry:
    major: int
    minor: int
    patch: int
    content: str

    @property
    def version(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"


def _normalize_tag(version: str | ChangelogEntry) -> str:
    version_string = version if isinstance(version, str) else version.version
    return version_string if version_string.startswith("v") else f"v{version_string}"


def _split_local_target(target: str) -> tuple[str, str, str]:
    hash_index = target.find("#")
    before_hash = target if hash_index == -1 else target[:hash_index]
    fragment = "" if hash_index == -1 else target[hash_index:]
    query_index = before_hash.find("?")
    if query_index == -1:
        return fragment, before_hash, ""
    return fragment, before_hash[:query_index], before_hash[query_index:]


def _resolve_repository_path(target_path: str) -> str | None:
    normalized_target = target_path.replace("\\", "/")
    joined = (
        normalized_target.lstrip("/")
        if normalized_target.startswith("/")
        else f"{CHANGELOG_LINK_BASE_PATH}/{normalized_target}".replace("//", "/")
    )
    if joined in (".", "..") or joined.startswith("../"):
        return None
    return joined


def _is_directory_target(original_path: str, repository_path: str) -> bool:
    if original_path.endswith("/"):
        return True
    basename = repository_path.rsplit("/", 1)[-1]
    return "." not in basename


def _normalize_changelog_link_target(target: str, tag: str) -> str:
    canonical_target = LEGACY_REPO_RE.sub(f"https://github.com/{GITHUB_REPO}", target)
    repo_url = f"https://github.com/{GITHUB_REPO}"
    for route in ("blob", "tree"):
        for branch in ("main", "master"):
            prefix = f"{repo_url}/{route}/{branch}/"
            if canonical_target.startswith(prefix):
                canonical_target = f"{repo_url}/{route}/{tag}/{canonical_target[len(prefix):]}"
    if (
        canonical_target.startswith("#")
        or canonical_target.startswith("//")
        or URL_SCHEME_RE.match(canonical_target)
    ):
        return canonical_target
    fragment, path_part, query = _split_local_target(canonical_target)
    if not path_part:
        return canonical_target
    repository_path = _resolve_repository_path(path_part)
    if repository_path is None:
        return canonical_target
    route = "tree" if _is_directory_target(path_part, repository_path) else "blob"
    return f"https://github.com/{GITHUB_REPO}/{route}/{tag}/{repository_path}{query}{fragment}"


def normalize_changelog_links(markdown: str, version: str | ChangelogEntry) -> str:
    tag = _normalize_tag(version)

    def replacer(match: re.Match[str]) -> str:
        return f"{match.group(1)}{_normalize_changelog_link_target(match.group(2), tag)}{match.group(3)}"

    return INLINE_MARKDOWN_LINK_RE.sub(replacer, markdown)


def parse_changelog(changelog_path: str | Path) -> list[ChangelogEntry]:
    path = Path(changelog_path)
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []

    entries: list[ChangelogEntry] = []
    current_lines: list[str] = []
    current_version: tuple[int, int, int] | None = None

    for line in lines:
        if line.startswith("## "):
            if current_version is not None and current_lines:
                entries.append(
                    ChangelogEntry(
                        major=current_version[0],
                        minor=current_version[1],
                        patch=current_version[2],
                        content="\n".join(current_lines).strip(),
                    )
                )
            version_match = re.match(r"##\s+\[?(\d+)\.(\d+)\.(\d+)\]?", line)
            if version_match:
                current_version = (
                    int(version_match.group(1)),
                    int(version_match.group(2)),
                    int(version_match.group(3)),
                )
                current_lines = [line]
            else:
                current_version = None
                current_lines = []
        elif current_version is not None:
            current_lines.append(line)

    if current_version is not None and current_lines:
        entries.append(
            ChangelogEntry(
                major=current_version[0],
                minor=current_version[1],
                patch=current_version[2],
                content="\n".join(current_lines).strip(),
            )
        )
    return entries


def compare_versions(left: ChangelogEntry, right: ChangelogEntry) -> int:
    if left.major != right.major:
        return left.major - right.major
    if left.minor != right.minor:
        return left.minor - right.minor
    return left.patch - right.patch


def get_new_entries(entries: list[ChangelogEntry], last_version: str) -> list[ChangelogEntry]:
    parts = last_version.split(".")
    last = ChangelogEntry(
        major=int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0,
        minor=int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0,
        patch=int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0,
        content="",
    )
    return [entry for entry in entries if compare_versions(entry, last) > 0]


def format_changelog_markdown(entries: list[ChangelogEntry]) -> str:
    parts: list[str] = []
    for entry in entries:
        parts.append(normalize_changelog_links(entry.content, entry))
    return "\n\n".join(parts)
