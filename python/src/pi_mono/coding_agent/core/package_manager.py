"""Package manager for extension packages (local paths, npm, git).

Ported from packages/coding-agent/src/core/package-manager.ts (install/remove subset).
"""

from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from typing import Any, Callable, Literal, TypedDict, Union, cast

from pi_mono.coding_agent.core.extensions.loader import (
    _resolve_extension_entries,
    discover_extensions_in_dir,
)
from pi_mono.config import CONFIG_DIR_NAME
from pi_mono.core.settings_manager import PackageSource, SettingsManager
from pi_mono.utils.git import GitSource, parse_git_url
from pi_mono.utils.paths import (
    is_local_path,
    mark_path_ignored_by_cloud_sync,
    normalize_path,
    resolve_path,
)
from pi_mono.utils.semver import get_npm_version_range, is_exact_npm_version, max_satisfying

SourceScope = Literal["user", "project", "temporary"]
ResourceType = Literal["extensions", "skills", "prompts", "themes"]
MissingSourceAction = Literal["install", "skip", "error"]

RESOURCE_TYPES: tuple[ResourceType, ...] = ("extensions", "skills", "prompts", "themes")
FILE_SUFFIXES: dict[ResourceType, tuple[str, ...]] = {
    "extensions": (".py", ".ts", ".js", ".mts", ".mjs"),
    "skills": (".md",),
    "prompts": (".md",),
    "themes": (".json",),
}

NETWORK_TIMEOUT_MS = 10000


class PathMetadata(TypedDict, total=False):
    source: str
    scope: SourceScope
    origin: Literal["package", "top-level"]
    baseDir: str


class ResolvedResource(TypedDict):
    path: str
    enabled: bool
    metadata: PathMetadata


class ResolvedPaths(TypedDict):
    extensions: list[ResolvedResource]
    skills: list[ResolvedResource]
    prompts: list[ResolvedResource]
    themes: list[ResolvedResource]


class ConfiguredPackage(TypedDict, total=False):
    source: str
    scope: SourceScope
    filtered: bool
    installedPath: str | None


@dataclass(frozen=True)
class PackageUpdate:
    source: str
    display_name: str
    type: Literal["npm", "git"]
    scope: SourceScope


@dataclass(frozen=True)
class LocalSource:
    type: Literal["local"] = "local"
    path: str = ""


@dataclass(frozen=True)
class NpmSource:
    type: Literal["npm"] = "npm"
    spec: str = ""
    name: str = ""
    version: str | None = None
    range: str | None = None
    pinned: bool = False


ParsedSource = Union[NpmSource, GitSource, LocalSource]

ProgressCallback = Callable[[dict[str, Any]], None]


def _empty_resolved_paths() -> ResolvedPaths:
    return {
        "extensions": [],
        "skills": [],
        "prompts": [],
        "themes": [],
    }


def _is_offline_mode_enabled() -> bool:
    value = os.environ.get("PI_OFFLINE", "")
    return value in ("1", "true", "True", "yes", "YES")


def _create_resource_accumulator() -> dict[ResourceType, dict[str, dict[str, Any]]]:
    return {resource_type: {} for resource_type in RESOURCE_TYPES}


def _resource_precedence_rank(metadata: PathMetadata) -> int:
    """Lower rank loads first; first-loaded skill name wins on collision."""
    if metadata.get("origin") == "package":
        return 4
    scope_base = 0 if metadata.get("scope") == "project" else 2
    return scope_base + (0 if metadata.get("source") == "local" else 1)


def _to_resolved_paths(accumulator: dict[ResourceType, dict[str, dict[str, Any]]]) -> ResolvedPaths:
    resolved = _empty_resolved_paths()
    for resource_type in RESOURCE_TYPES:
        entries: list[dict[str, Any]] = []
        for path, entry in accumulator[resource_type].items():
            entries.append(
                {
                    "path": path,
                    "enabled": bool(entry.get("enabled", True)),
                    "metadata": entry.get("metadata", {}),
                }
            )
        entries.sort(
            key=lambda item: _resource_precedence_rank(cast(PathMetadata, item["metadata"]))
        )
        seen: set[str] = set()
        for entry in entries:
            canonical = os.path.realpath(entry["path"])
            if canonical in seen:
                continue
            seen.add(canonical)
            resolved[resource_type].append(entry)
    return resolved


def _matches_resource_file(path: str, resource_type: ResourceType) -> bool:
    name = os.path.basename(path)
    if name.startswith("."):
        return False
    suffixes = FILE_SUFFIXES[resource_type]
    if resource_type == "skills" and name == "SKILL.md":
        return True
    return any(name.endswith(suffix) for suffix in suffixes)


def _collect_files_from_path(path: str, resource_type: ResourceType) -> list[str]:
    if not os.path.exists(path):
        return []
    if os.path.isfile(path):
        return [path] if _matches_resource_file(path, resource_type) else []
    if not os.path.isdir(path):
        return []

    if resource_type == "extensions":
        entries = _resolve_extension_entries(path)
        if entries:
            return entries
        return discover_extensions_in_dir(path)

    collected: list[str] = []
    for root, dirnames, filenames in os.walk(path):
        dirnames[:] = [
            name for name in dirnames if not name.startswith(".") and name != "node_modules"
        ]
        for filename in filenames:
            if filename.startswith("."):
                continue
            full_path = os.path.join(root, filename)
            if _matches_resource_file(full_path, resource_type):
                collected.append(full_path)
    return collected


def _read_pi_manifest(package_root: str) -> dict[str, Any] | None:
    package_json_path = os.path.join(package_root, "package.json")
    if not os.path.exists(package_json_path):
        return None
    try:
        with open(package_json_path, encoding="utf-8") as handle:
            package = json.load(handle)
        pi_manifest = package.get("pi")
        return pi_manifest if isinstance(pi_manifest, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _split_pattern_entries(entries: list[str]) -> tuple[list[str], list[str]]:
    plain: list[str] = []
    patterns: list[str] = []
    for entry in entries:
        if any(entry.startswith(prefix) for prefix in ("!", "+", "-")):
            patterns.append(entry)
        elif any(char in entry for char in ("*", "?", "[")):
            patterns.append(entry)
        else:
            plain.append(entry)
    return plain, patterns


def _matches_any_pattern(file_path: str, patterns: list[str], base_dir: str) -> bool:
    rel = os.path.relpath(file_path, base_dir).replace(os.sep, "/")
    name = os.path.basename(file_path)
    for pattern in patterns:
        normalized = pattern.lstrip("./").replace("\\", "/")
        if (
            fnmatch.fnmatch(rel, normalized)
            or fnmatch.fnmatch(name, normalized)
            or fnmatch.fnmatch(file_path, pattern)
        ):
            return True
    return False


def _apply_pattern_entries(all_files: list[str], patterns: list[str], base_dir: str) -> set[str]:
    if not patterns:
        return set(all_files)
    includes = [pattern for pattern in patterns if not pattern.startswith(("!", "+", "-"))]
    excludes = [pattern[1:] for pattern in patterns if pattern.startswith("!")]
    force_includes = [pattern[1:] for pattern in patterns if pattern.startswith("+")]
    force_excludes = [pattern[1:] for pattern in patterns if pattern.startswith("-")]

    if includes:
        result = [
            file_path
            for file_path in all_files
            if _matches_any_pattern(file_path, includes, base_dir)
        ]
    else:
        result = list(all_files)

    if excludes:
        result = [
            file_path
            for file_path in result
            if not _matches_any_pattern(file_path, excludes, base_dir)
        ]

    for file_path in all_files:
        if file_path not in result and _matches_any_pattern(file_path, force_includes, base_dir):
            result.append(file_path)

    if force_excludes:
        result = [
            file_path
            for file_path in result
            if not _matches_any_pattern(file_path, force_excludes, base_dir)
        ]
    return set(result)


def parse_npm_spec(spec: str) -> tuple[str, str | None]:
    """Parse an npm spec into package name and optional version."""
    match = re.match(r"^(@?[^@]+(?:/[^@]+)?)(?:@(.+))?$", spec)
    if not match:
        return spec, None
    name = match.group(1) or spec
    version = match.group(2)
    return name, version


def get_extension_temp_folder(agent_dir: str) -> str:
    temp_folder = os.path.join(agent_dir, "tmp", "extensions")
    os.makedirs(temp_folder, mode=0o700, exist_ok=True)
    os.chmod(temp_folder, 0o700)
    return temp_folder


def parse_source(source: str) -> ParsedSource:
    """Parse a package source string (local paths, npm:, and git URLs)."""
    trimmed = source.strip()
    if trimmed.startswith("npm:"):
        spec = trimmed[len("npm:") :].strip()
        name, version = parse_npm_spec(spec)
        return NpmSource(
            spec=spec,
            name=name,
            version=version,
            range=get_npm_version_range(version),
            pinned=is_exact_npm_version(version),
        )

    if trimmed.startswith("file://"):
        path = normalize_path(trimmed, trim=True, expand_tilde=True)
        return LocalSource(path=path)

    git_parsed = parse_git_url(trimmed)
    if git_parsed is not None:
        return git_parsed

    if is_local_path(trimmed):
        path = normalize_path(trimmed, trim=True, expand_tilde=True)
        return LocalSource(path=path)

    return LocalSource(path=trimmed)


class DefaultPackageManager:
    def __init__(
        self,
        *,
        cwd: str,
        agent_dir: str,
        settings_manager: SettingsManager,
    ) -> None:
        self._cwd = resolve_path(cwd, cwd)
        self._agent_dir = resolve_path(agent_dir, cwd)
        self._settings_manager = settings_manager
        self._progress_callback: ProgressCallback | None = None

    def set_progress_callback(self, callback: ProgressCallback | None) -> None:
        self._progress_callback = callback

    def _emit_progress(self, event: dict[str, Any]) -> None:
        if self._progress_callback is not None:
            self._progress_callback(event)

    def _get_base_dir_for_scope(self, scope: SourceScope) -> str:
        if scope == "project":
            return os.path.join(self._cwd, CONFIG_DIR_NAME)
        return self._agent_dir

    def _get_packages_root(self, scope: SourceScope) -> str:
        return os.path.join(self._get_base_dir_for_scope(scope), "packages")

    def _get_npm_install_root(self, scope: SourceScope) -> str:
        return os.path.join(self._get_base_dir_for_scope(scope), "npm")

    def _get_git_install_root(self, scope: SourceScope) -> str:
        return os.path.join(self._get_base_dir_for_scope(scope), "git")

    def _resolve_managed_path(self, root: str, *parts: str) -> str:
        resolved_root = os.path.realpath(root)
        resolved_path = os.path.realpath(os.path.join(resolved_root, *parts))
        if resolved_path != resolved_root and not resolved_path.startswith(resolved_root + os.sep):
            raise ValueError(f"Refusing to use path outside package install root: {resolved_path}")
        return resolved_path

    def _get_npm_install_path(self, source: NpmSource, scope: SourceScope) -> str:
        install_root = self._get_npm_install_root(scope)
        return os.path.join(install_root, "node_modules", source.name)

    def _get_git_install_path(self, source: GitSource, scope: SourceScope) -> str:
        install_root = self._get_git_install_root(scope)
        return self._resolve_managed_path(install_root, source.host, source.path)

    def _resolve_input_path(self, path: str) -> str:
        return resolve_path(path, self._cwd, trim=True, expand_tilde=True)

    def _resolve_path_from_base(self, path: str, base_dir: str) -> str:
        return resolve_path(path, base_dir, trim=True, expand_tilde=True)

    def _package_source_string(self, pkg: PackageSource) -> str:
        return pkg if isinstance(pkg, str) else str(pkg.get("source", ""))

    def _source_match_key_for_input(self, source: str) -> str:
        parsed = parse_source(source)
        if isinstance(parsed, NpmSource):
            return f"npm:{parsed.name}"
        if isinstance(parsed, GitSource):
            return f"git:{parsed.host}/{parsed.path}"
        return f"local:{self._resolve_input_path(parsed.path)}"

    def _source_match_key_for_settings(self, source: str, scope: SourceScope) -> str:
        parsed = parse_source(source)
        if isinstance(parsed, NpmSource):
            return f"npm:{parsed.name}"
        if isinstance(parsed, GitSource):
            return f"git:{parsed.host}/{parsed.path}"
        base_dir = self._get_base_dir_for_scope(scope)
        return f"local:{self._resolve_path_from_base(parsed.path, base_dir)}"

    def _package_sources_match(
        self, existing: PackageSource, input_source: str, scope: SourceScope
    ) -> bool:
        left = self._source_match_key_for_settings(self._package_source_string(existing), scope)
        right = self._source_match_key_for_input(input_source)
        return left == right

    def _normalize_package_source_for_settings(self, source: str, scope: SourceScope) -> str:
        parsed = parse_source(source)
        if not isinstance(parsed, LocalSource):
            return source
        base_dir = self._get_base_dir_for_scope(scope)
        resolved = self._resolve_input_path(parsed.path)
        rel = os.path.relpath(resolved, base_dir)
        if rel == ".":
            return "."
        return rel.replace(os.sep, "/")

    def _install_dir_name(self, resolved_path: str) -> str:
        base_name = os.path.basename(resolved_path.rstrip(os.sep)) or "package"
        digest = hashlib.sha256(resolved_path.encode("utf-8")).hexdigest()[:8]
        return f"{base_name}-{digest}"

    def _get_installed_dir(self, source: str, scope: SourceScope) -> str | None:
        parsed = parse_source(source)
        if isinstance(parsed, NpmSource):
            path = self._get_npm_install_path(parsed, scope)
            return path if os.path.exists(path) else None
        if isinstance(parsed, GitSource):
            path = self._get_git_install_path(parsed, scope)
            return path if os.path.exists(path) else None
        if isinstance(parsed, LocalSource):
            resolved = self._resolve_input_path(parsed.path)
            install_name = self._install_dir_name(resolved)
            installed = os.path.join(self._get_packages_root(scope), install_name)
            return installed if os.path.exists(installed) else None
        return None

    def get_installed_path(self, source: str, scope: SourceScope) -> str | None:
        parsed = parse_source(source)
        if isinstance(parsed, NpmSource):
            path = self._get_npm_install_path(parsed, scope)
            return path if os.path.exists(path) else None
        if isinstance(parsed, GitSource):
            path = self._get_git_install_path(parsed, scope)
            return path if os.path.exists(path) else None
        installed = self._get_installed_dir(source, scope)
        if installed is not None:
            return installed
        path = self._resolve_path_from_base(parsed.path, self._get_base_dir_for_scope(scope))
        return path if os.path.exists(path) else None

    def add_source_to_settings(self, source: str, *, local: bool = False) -> bool:
        scope: SourceScope = "project" if local else "user"
        current_settings = (
            self._settings_manager.get_project_settings()
            if scope == "project"
            else self._settings_manager.get_global_settings()
        )
        current_packages = list(current_settings.get("packages") or [])
        normalized_source = self._normalize_package_source_for_settings(source, scope)
        match_index = next(
            (
                index
                for index, existing in enumerate(current_packages)
                if self._package_sources_match(existing, source, scope)
            ),
            -1,
        )
        if match_index != -1:
            existing = current_packages[match_index]
            existing_source = self._package_source_string(existing)
            if existing_source == normalized_source:
                return False
            next_packages = list(current_packages)
            next_packages[match_index] = (
                normalized_source
                if isinstance(existing, str)
                else {**existing, "source": normalized_source}
            )
        else:
            next_packages = [*current_packages, normalized_source]

        if scope == "project":
            self._settings_manager.set_project_packages(next_packages)
        else:
            self._settings_manager.set_packages(next_packages)
        return True

    def remove_source_from_settings(self, source: str, *, local: bool = False) -> bool:
        scope: SourceScope = "project" if local else "user"
        current_settings = (
            self._settings_manager.get_project_settings()
            if scope == "project"
            else self._settings_manager.get_global_settings()
        )
        current_packages = list(current_settings.get("packages") or [])
        next_packages = [
            existing
            for existing in current_packages
            if not self._package_sources_match(existing, source, scope)
        ]
        if len(next_packages) == len(current_packages):
            return False
        if scope == "project":
            self._settings_manager.set_project_packages(next_packages)
        else:
            self._settings_manager.set_packages(next_packages)
        return True

    def list_configured_packages(self) -> list[ConfiguredPackage]:
        configured: list[ConfiguredPackage] = []
        global_settings = self._settings_manager.get_global_settings()
        project_settings = self._settings_manager.get_project_settings()

        for pkg in global_settings.get("packages") or []:
            source = self._package_source_string(pkg)
            configured.append(
                {
                    "source": source,
                    "scope": "user",
                    "filtered": not isinstance(pkg, str),
                    "installedPath": self.get_installed_path(source, "user"),
                }
            )

        for pkg in project_settings.get("packages") or []:
            source = self._package_source_string(pkg)
            configured.append(
                {
                    "source": source,
                    "scope": "project",
                    "filtered": not isinstance(pkg, str),
                    "installedPath": self.get_installed_path(source, "project"),
                }
            )

        return configured

    def _add_resource(
        self,
        target: dict[str, dict[str, Any]],
        path: str,
        metadata: PathMetadata,
        enabled: bool,
    ) -> None:
        normalized = os.path.abspath(path)
        target[normalized] = {"metadata": metadata, "enabled": enabled}

    def _get_target_map(
        self,
        accumulator: dict[ResourceType, dict[str, dict[str, Any]]],
        resource_type: ResourceType,
    ) -> dict[str, dict[str, Any]]:
        return accumulator[resource_type]

    def _get_package_identity(self, source: str, scope: SourceScope | None = None) -> str:
        parsed = parse_source(source)
        if isinstance(parsed, NpmSource):
            return f"npm:{parsed.name}"
        if isinstance(parsed, GitSource):
            return f"git:{parsed.host}/{parsed.path}"
        if scope is not None:
            base_dir = self._get_base_dir_for_scope(scope)
            return f"local:{self._resolve_path_from_base(parsed.path, base_dir)}"
        return f"local:{self._resolve_input_path(parsed.path)}"

    def _dedupe_packages(
        self,
        packages: list[tuple[PackageSource, SourceScope]],
    ) -> list[tuple[PackageSource, SourceScope]]:
        seen: dict[str, tuple[PackageSource, SourceScope]] = {}
        for package, scope in packages:
            source_str = self._package_source_string(package)
            identity = self._get_package_identity(source_str, scope)
            existing = seen.get(identity)
            if existing is None:
                seen[identity] = (package, scope)
            elif scope == "project" and existing[1] == "user":
                seen[identity] = (package, scope)
        return list(seen.values())

    def _collect_package_resources(
        self,
        package_root: str,
        accumulator: dict[ResourceType, dict[str, dict[str, Any]]],
        package_filter: dict[str, list[str]] | None,
        metadata: PathMetadata,
    ) -> bool:
        if package_filter is not None:
            for resource_type in RESOURCE_TYPES:
                patterns = package_filter.get(resource_type)
                target = self._get_target_map(accumulator, resource_type)
                if patterns is not None:
                    all_files: list[str] = []
                    manifest = _read_pi_manifest(package_root)
                    manifest_entries = manifest.get(resource_type) if manifest else None
                    if isinstance(manifest_entries, list) and manifest_entries:
                        plain_entries, _pattern_entries = _split_pattern_entries(
                            [str(entry) for entry in manifest_entries]
                        )
                        for entry in plain_entries:
                            all_files.extend(
                                _collect_files_from_path(
                                    os.path.join(package_root, entry), resource_type
                                )
                            )
                    else:
                        convention_dir = os.path.join(package_root, resource_type)
                        all_files.extend(_collect_files_from_path(convention_dir, resource_type))
                    enabled_paths = _apply_pattern_entries(all_files, patterns, package_root)
                    for file_path in all_files:
                        self._add_resource(target, file_path, metadata, file_path in enabled_paths)
                else:
                    self._collect_default_package_resources(
                        package_root, resource_type, target, metadata
                    )
            return True

        manifest = _read_pi_manifest(package_root)
        if manifest is not None:
            for resource_type in RESOURCE_TYPES:
                entries = manifest.get(resource_type)
                if isinstance(entries, list) and entries:
                    target = self._get_target_map(accumulator, resource_type)
                    plain_entries, pattern_entries = _split_pattern_entries(
                        [str(entry) for entry in entries]
                    )
                    all_files: list[str] = []
                    for entry in plain_entries:
                        all_files.extend(
                            _collect_files_from_path(
                                os.path.join(package_root, entry), resource_type
                            )
                        )
                    enabled_paths = _apply_pattern_entries(all_files, pattern_entries, package_root)
                    for file_path in all_files:
                        if file_path in enabled_paths:
                            self._add_resource(target, file_path, metadata, True)
            return True

        has_any_dir = False
        for resource_type in RESOURCE_TYPES:
            convention_dir = os.path.join(package_root, resource_type)
            if os.path.isdir(convention_dir):
                target = self._get_target_map(accumulator, resource_type)
                for file_path in _collect_files_from_path(convention_dir, resource_type):
                    self._add_resource(target, file_path, metadata, True)
                has_any_dir = True
        return has_any_dir

    def _collect_default_package_resources(
        self,
        package_root: str,
        resource_type: ResourceType,
        target: dict[str, dict[str, Any]],
        metadata: PathMetadata,
    ) -> None:
        manifest = _read_pi_manifest(package_root)
        entries = manifest.get(resource_type) if manifest else None
        if isinstance(entries, list) and entries:
            plain_entries, pattern_entries = _split_pattern_entries(
                [str(entry) for entry in entries]
            )
            all_files: list[str] = []
            for entry in plain_entries:
                all_files.extend(
                    _collect_files_from_path(os.path.join(package_root, entry), resource_type)
                )
            enabled_paths = _apply_pattern_entries(all_files, pattern_entries, package_root)
            for file_path in all_files:
                if file_path in enabled_paths:
                    self._add_resource(target, file_path, metadata, True)
            return
        convention_dir = os.path.join(package_root, resource_type)
        if os.path.isdir(convention_dir):
            for file_path in _collect_files_from_path(convention_dir, resource_type):
                self._add_resource(target, file_path, metadata, True)

    def _resolve_local_entries(
        self,
        entries: list[str],
        resource_type: ResourceType,
        target: dict[str, dict[str, Any]],
        metadata: PathMetadata,
        base_dir: str,
    ) -> None:
        if not entries:
            return
        plain_entries, pattern_entries = _split_pattern_entries(entries)
        all_files: list[str] = []
        for entry in plain_entries:
            resolved = self._resolve_path_from_base(entry, base_dir)
            all_files.extend(_collect_files_from_path(resolved, resource_type))
        enabled_paths = _apply_pattern_entries(all_files, pattern_entries, base_dir)
        for file_path in all_files:
            self._add_resource(target, file_path, metadata, file_path in enabled_paths)

    def _resolve_local_extension_source(
        self,
        source: LocalSource,
        accumulator: dict[ResourceType, dict[str, dict[str, Any]]],
        package_filter: dict[str, list[str]] | None,
        metadata: PathMetadata,
        base_dir: str,
    ) -> None:
        resolved = self._resolve_path_from_base(source.path, base_dir)
        if not os.path.exists(resolved):
            return
        if os.path.isfile(resolved):
            metadata_with_base = {**metadata, "baseDir": os.path.dirname(resolved)}
            self._add_resource(
                self._get_target_map(accumulator, "extensions"), resolved, metadata_with_base, True
            )
            return
        if os.path.isdir(resolved):
            metadata_with_base = {**metadata, "baseDir": resolved}
            if package_filter is not None:
                self._collect_package_resources(
                    resolved, accumulator, package_filter, metadata_with_base
                )
                return
            collected = self._collect_package_resources(
                resolved, accumulator, None, metadata_with_base
            )
            if not collected:
                self._add_resource(
                    self._get_target_map(accumulator, "extensions"),
                    resolved,
                    metadata_with_base,
                    True,
                )

    async def _install_parsed_source(self, parsed: ParsedSource, scope: SourceScope) -> None:
        if isinstance(parsed, NpmSource):
            await self.install_npm(parsed, scope, scope == "temporary")
            return
        if isinstance(parsed, GitSource):
            await self.install_git(parsed, scope)

    async def _resolve_package_sources(
        self,
        sources: list[tuple[PackageSource, SourceScope]],
        accumulator: dict[ResourceType, dict[str, dict[str, Any]]],
        on_missing: Callable[[str], Any] | None = None,
    ) -> None:
        for package, scope in sources:
            source_str = self._package_source_string(package)
            package_filter: dict[str, list[str]] | None = (
                package if isinstance(package, dict) else None
            )
            parsed = parse_source(source_str)
            metadata: PathMetadata = {"source": source_str, "scope": scope, "origin": "package"}

            if isinstance(parsed, LocalSource):
                self._resolve_local_extension_source(
                    parsed,
                    accumulator,
                    package_filter if isinstance(package_filter, dict) else None,
                    metadata,
                    self._get_base_dir_for_scope(scope),
                )
                continue

            async def install_missing() -> bool:
                if _is_offline_mode_enabled():
                    return False
                if on_missing is None:
                    await self._install_parsed_source(parsed, scope)
                    return True
                action = await on_missing(source_str)
                if action == "skip":
                    return False
                if action == "error":
                    raise ValueError(f"Missing source: {source_str}")
                await self._install_parsed_source(parsed, scope)
                return True

            if isinstance(parsed, NpmSource):
                installed_path = self._get_npm_install_path(parsed, scope)
                if not os.path.exists(installed_path):
                    installed = await install_missing()
                    if not installed:
                        continue
                    installed_path = self._get_npm_install_path(parsed, scope)
                metadata = {**metadata, "baseDir": installed_path}
                self._collect_package_resources(
                    installed_path,
                    accumulator,
                    package_filter if isinstance(package_filter, dict) else None,
                    metadata,
                )
                continue

            if isinstance(parsed, GitSource):
                installed_path = self._get_git_install_path(parsed, scope)
                if not os.path.exists(installed_path):
                    installed = await install_missing()
                    if not installed:
                        continue
                    installed_path = self._get_git_install_path(parsed, scope)
                metadata = {**metadata, "baseDir": installed_path}
                self._collect_package_resources(
                    installed_path,
                    accumulator,
                    package_filter if isinstance(package_filter, dict) else None,
                    metadata,
                )

    def _add_auto_discovered_resources(
        self,
        accumulator: dict[ResourceType, dict[str, dict[str, Any]]],
        global_settings: dict[str, Any],
        project_settings: dict[str, Any],
        global_base_dir: str,
        project_base_dir: str,
    ) -> None:
        user_metadata: PathMetadata = {
            "source": "auto",
            "scope": "user",
            "origin": "top-level",
            "baseDir": global_base_dir,
        }
        project_metadata: PathMetadata = {
            "source": "auto",
            "scope": "project",
            "origin": "top-level",
            "baseDir": project_base_dir,
        }
        user_dirs = {
            "extensions": os.path.join(global_base_dir, "extensions"),
            "skills": os.path.join(global_base_dir, "skills"),
            "prompts": os.path.join(global_base_dir, "prompts"),
            "themes": os.path.join(global_base_dir, "themes"),
        }
        project_dirs = {
            "extensions": os.path.join(project_base_dir, "extensions"),
            "skills": os.path.join(project_base_dir, "skills"),
            "prompts": os.path.join(project_base_dir, "prompts"),
            "themes": os.path.join(project_base_dir, "themes"),
        }

        def add_resources(
            resource_type: ResourceType,
            directory: str,
            metadata: PathMetadata,
            overrides: list[str],
            base_dir: str,
        ) -> None:
            if not os.path.isdir(directory):
                return
            target = self._get_target_map(accumulator, resource_type)
            for file_path in _collect_files_from_path(directory, resource_type):
                enabled = True
                if overrides:
                    enabled = file_path in _apply_pattern_entries([file_path], overrides, base_dir)
                self._add_resource(target, file_path, metadata, enabled)

        for resource_type in RESOURCE_TYPES:
            add_resources(
                resource_type,
                project_dirs[resource_type],
                project_metadata,
                list(project_settings.get(resource_type) or []),
                project_base_dir,
            )
            add_resources(
                resource_type,
                user_dirs[resource_type],
                user_metadata,
                list(global_settings.get(resource_type) or []),
                global_base_dir,
            )

    async def resolve(
        self,
        on_missing: Callable[[str], Any] | None = None,
    ) -> ResolvedPaths:
        accumulator = _create_resource_accumulator()
        global_settings = self._settings_manager.get_global_settings()
        project_settings = self._settings_manager.get_project_settings()

        all_packages: list[tuple[PackageSource, SourceScope]] = []
        for package in project_settings.get("packages") or []:
            all_packages.append((package, "project"))
        for package in global_settings.get("packages") or []:
            all_packages.append((package, "user"))
        package_sources = self._dedupe_packages(all_packages)
        await self._resolve_package_sources(package_sources, accumulator, on_missing)

        global_base_dir = self._agent_dir
        project_base_dir = os.path.join(self._cwd, CONFIG_DIR_NAME)
        for resource_type in RESOURCE_TYPES:
            target = self._get_target_map(accumulator, resource_type)
            project_entries = list(project_settings.get(resource_type) or [])
            global_entries = list(global_settings.get(resource_type) or [])
            project_metadata: PathMetadata = {
                "source": "local",
                "scope": "project",
                "origin": "top-level",
            }
            global_metadata: PathMetadata = {
                "source": "local",
                "scope": "user",
                "origin": "top-level",
            }
            self._resolve_local_entries(
                project_entries, resource_type, target, project_metadata, project_base_dir
            )
            self._resolve_local_entries(
                global_entries, resource_type, target, global_metadata, global_base_dir
            )

        self._add_auto_discovered_resources(
            accumulator,
            global_settings,
            project_settings,
            global_base_dir,
            project_base_dir,
        )
        return _to_resolved_paths(accumulator)

    async def resolve_extension_sources(
        self,
        sources: list[str],
        *,
        local: bool = False,
        temporary: bool = False,
    ) -> ResolvedPaths:
        accumulator = _create_resource_accumulator()
        scope: SourceScope = "temporary" if temporary else ("project" if local else "user")
        package_sources = [(source, scope) for source in sources]
        await self._resolve_package_sources(package_sources, accumulator)
        return _to_resolved_paths(accumulator)

    def _get_npm_command(self) -> tuple[str, list[str]]:
        configured = self._settings_manager.get_npm_command()
        if not configured:
            return "npm", []
        command, *args = configured
        if not command:
            raise ValueError("Invalid npmCommand: first array entry must be a non-empty command")
        return command, args

    def _get_package_manager_name(self) -> str:
        command, args = self._get_npm_command()
        command_parts = [command, *args]
        separator_index = (
            len(command_parts) - 1 - command_parts[::-1].index("--")
            if "--" in command_parts
            else -1
        )
        package_manager_command = (
            command_parts[separator_index + 1] if separator_index >= 0 else command
        )
        base_name = os.path.basename(package_manager_command)
        return re.sub(r"\.(cmd|exe)$", "", base_name, flags=re.IGNORECASE)

    def _get_npm_install_args(self, specs: list[str], install_root: str) -> list[str]:
        package_manager_name = self._get_package_manager_name()
        if package_manager_name == "bun":
            return ["install", *specs, "--cwd", install_root, "--omit=peer"]
        if package_manager_name == "pnpm":
            return [
                "install",
                *specs,
                "--prefix",
                install_root,
                "--config.auto-install-peers=false",
                "--config.strict-peer-dependencies=false",
                "--config.strict-dep-builds=false",
            ]
        return ["install", *specs, "--prefix", install_root, "--legacy-peer-deps"]

    def _get_git_dependency_install_args(self) -> list[str]:
        configured = self._settings_manager.get_npm_command()
        if configured:
            return ["install"]
        return ["install", "--omit=dev"]

    async def _run_command(
        self,
        command: str,
        args: list[str],
        *,
        cwd: str | None = None,
        timeout_ms: int | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        process_env = os.environ.copy()
        if env:
            process_env.update(env)
        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=cwd,
            env=process_env,
        )
        try:
            await asyncio.wait_for(
                process.wait(), timeout=(timeout_ms / 1000) if timeout_ms else None
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(
                f"{command} {' '.join(args)} timed out after {timeout_ms}ms"
            ) from None
        if process.returncode != 0:
            raise RuntimeError(f"{command} {' '.join(args)} failed with code {process.returncode}")

    async def _run_command_capture(
        self,
        command: str,
        args: list[str],
        *,
        cwd: str | None = None,
        timeout_ms: int | None = None,
        env: dict[str, str] | None = None,
    ) -> str:
        process_env = os.environ.copy()
        if env:
            process_env.update(env)
        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=cwd,
            env=process_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=(timeout_ms / 1000) if timeout_ms else None,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(
                f"{command} {' '.join(args)} timed out after {timeout_ms}ms"
            ) from None
        if process.returncode != 0:
            output = (stderr or stdout or b"").decode("utf-8", errors="replace")
            raise RuntimeError(
                f"{command} {' '.join(args)} failed with code {process.returncode}: {output}"
            )
        return (stdout or b"").decode("utf-8", errors="replace").strip()

    async def _run_npm_command(self, args: list[str], *, cwd: str | None = None) -> None:
        command, prefix_args = self._get_npm_command()
        await self._run_command(
            command, [*prefix_args, *args], cwd=cwd, timeout_ms=NETWORK_TIMEOUT_MS
        )

    def _ensure_git_ignore(self, directory: str) -> None:
        os.makedirs(directory, exist_ok=True)
        ignore_path = os.path.join(directory, ".gitignore")
        if not os.path.exists(ignore_path):
            with open(ignore_path, "w", encoding="utf-8") as handle:
                handle.write("*\n!.gitignore\n")

    def _ensure_npm_project(self, install_root: str) -> None:
        os.makedirs(install_root, exist_ok=True)
        self._ensure_git_ignore(install_root)
        package_json_path = os.path.join(install_root, "package.json")
        if not os.path.exists(package_json_path):
            with open(package_json_path, "w", encoding="utf-8") as handle:
                json.dump({"name": "pi-extensions", "private": True}, handle, indent=2)
                handle.write("\n")

    async def install_npm(self, source: NpmSource, scope: SourceScope) -> None:
        install_root = self._get_npm_install_root(scope)
        self._ensure_npm_project(install_root)
        await self._run_npm_command(self._get_npm_install_args([source.spec], install_root))
        mark_path_ignored_by_cloud_sync(install_root)

    async def remove_npm(self, source: NpmSource, scope: SourceScope) -> None:
        install_root = self._get_npm_install_root(scope)
        if not os.path.exists(install_root):
            return
        package_manager_name = self._get_package_manager_name()
        if package_manager_name == "bun":
            await self._run_npm_command(["uninstall", source.name, "--cwd", install_root])
            return
        await self._run_npm_command(["uninstall", source.name, "--prefix", install_root])

    async def install_git(self, source: GitSource, scope: SourceScope) -> None:
        target_dir = self._get_git_install_path(source, scope)
        if os.path.exists(target_dir):
            return
        git_root = self._get_git_install_root(scope)
        self._ensure_git_ignore(git_root)
        os.makedirs(os.path.dirname(target_dir), exist_ok=True)
        await self._run_command(
            "git", ["clone", source.repo, target_dir], timeout_ms=NETWORK_TIMEOUT_MS
        )
        if source.ref:
            await self._run_command(
                "git",
                ["checkout", source.ref],
                cwd=target_dir,
                timeout_ms=NETWORK_TIMEOUT_MS,
            )
        package_json_path = os.path.join(target_dir, "package.json")
        if os.path.exists(package_json_path):
            await self._run_npm_command(self._get_git_dependency_install_args(), cwd=target_dir)

    async def remove_git(self, source: GitSource, scope: SourceScope) -> None:
        target_dir = self._get_git_install_path(source, scope)
        if not os.path.exists(target_dir):
            return
        shutil.rmtree(target_dir)
        self._prune_empty_git_parents(target_dir, self._get_git_install_root(scope))

    def _prune_empty_git_parents(self, target_dir: str, install_root: str) -> None:
        resolved_root = os.path.realpath(install_root)
        current = os.path.dirname(target_dir)
        while current.startswith(resolved_root) and current != resolved_root:
            if not os.path.exists(current):
                current = os.path.dirname(current)
                continue
            try:
                entries = os.listdir(current)
            except OSError:
                break
            if entries:
                break
            try:
                shutil.rmtree(current)
            except OSError:
                break
            current = os.path.dirname(current)

    def _install_local_copy(self, resolved_path: str, scope: SourceScope) -> str:
        packages_root = self._get_packages_root(scope)
        os.makedirs(packages_root, exist_ok=True)
        install_name = self._install_dir_name(resolved_path)
        target_dir = os.path.join(packages_root, install_name)

        if os.path.exists(target_dir):
            if os.path.islink(target_dir) or os.path.isfile(target_dir):
                os.remove(target_dir)
            else:
                shutil.rmtree(target_dir)

        try:
            os.symlink(resolved_path, target_dir, target_is_directory=os.path.isdir(resolved_path))
        except OSError:
            if os.path.isdir(resolved_path):
                shutil.copytree(resolved_path, target_dir, symlinks=True)
            else:
                shutil.copy2(resolved_path, target_dir)
        return target_dir

    async def install_local_path(self, source: str, *, local: bool = False) -> None:
        parsed = parse_source(source)
        scope: SourceScope = "project" if local else "user"
        resolved = self._resolve_input_path(parsed.path)
        if not os.path.exists(resolved):
            raise FileNotFoundError(f"Path does not exist: {resolved}")

        self._emit_progress(
            {
                "type": "start",
                "action": "install",
                "source": source,
                "message": f"Installing {source}...",
            }
        )
        try:
            self._install_local_copy(resolved, scope)
            self._emit_progress({"type": "complete", "action": "install", "source": source})
        except Exception as error:
            self._emit_progress(
                {
                    "type": "error",
                    "action": "install",
                    "source": source,
                    "message": str(error),
                }
            )
            raise

    async def install(self, source: str, *, local: bool = False) -> None:
        parsed = parse_source(source)
        scope: SourceScope = "project" if local else "user"
        self._emit_progress(
            {
                "type": "start",
                "action": "install",
                "source": source,
                "message": f"Installing {source}...",
            }
        )
        try:
            if isinstance(parsed, NpmSource):
                await self.install_npm(parsed, scope)
            elif isinstance(parsed, GitSource):
                await self.install_git(parsed, scope)
            elif isinstance(parsed, LocalSource):
                resolved = self._resolve_input_path(parsed.path)
                if not os.path.exists(resolved):
                    raise FileNotFoundError(f"Path does not exist: {resolved}")
                self._install_local_copy(resolved, scope)
            else:
                raise ValueError(f"Unsupported install source: {source}")
            self._emit_progress({"type": "complete", "action": "install", "source": source})
        except Exception as error:
            self._emit_progress(
                {
                    "type": "error",
                    "action": "install",
                    "source": source,
                    "message": str(error),
                }
            )
            raise

    async def install_and_persist(self, source: str, *, local: bool = False) -> None:
        await self.install(source, local=local)
        self.add_source_to_settings(source, local=local)
        await self._settings_manager.flush()

    async def remove_package(self, source: str, *, local: bool = False) -> None:
        scope: SourceScope = "project" if local else "user"
        parsed = parse_source(source)
        self._emit_progress(
            {
                "type": "start",
                "action": "remove",
                "source": source,
                "message": f"Removing {source}...",
            }
        )
        try:
            if isinstance(parsed, NpmSource):
                await self.remove_npm(parsed, scope)
            elif isinstance(parsed, GitSource):
                await self.remove_git(parsed, scope)
            elif isinstance(parsed, LocalSource):
                installed = self._get_installed_dir(source, scope)
                if installed is not None:
                    if os.path.islink(installed) or os.path.isfile(installed):
                        os.remove(installed)
                    elif os.path.isdir(installed):
                        shutil.rmtree(installed)
            else:
                raise ValueError(f"Unsupported remove source: {source}")
            self._emit_progress({"type": "complete", "action": "remove", "source": source})
        except Exception as error:
            self._emit_progress(
                {
                    "type": "error",
                    "action": "remove",
                    "source": source,
                    "message": str(error),
                }
            )
            raise

    async def remove_and_persist(self, source: str, *, local: bool = False) -> bool:
        await self.remove_package(source, local=local)
        removed = self.remove_source_from_settings(source, local=local)
        if removed:
            await self._settings_manager.flush()
        return removed

    def _is_offline_mode_enabled(self) -> bool:
        value = os.environ.get("PI_OFFLINE", "")
        if not value:
            return False
        return value in ("1", "true", "True", "yes", "YES")

    def _get_installed_npm_version(self, install_path: str) -> str | None:
        package_json_path = os.path.join(install_path, "package.json")
        if not os.path.exists(package_json_path):
            return None
        try:
            with open(package_json_path, encoding="utf-8") as handle:
                data = json.load(handle)
            version = data.get("version")
            return str(version) if version else None
        except (OSError, json.JSONDecodeError):
            return None

    async def _get_latest_npm_version(
        self, package_spec: str, range_spec: str | None = None
    ) -> str:
        command, prefix_args = self._get_npm_command()
        output = await self._run_command_capture(
            command,
            [*prefix_args, "view", package_spec, "version", "--json"],
            timeout_ms=NETWORK_TIMEOUT_MS,
        )
        raw = output.strip()
        if not raw:
            raise RuntimeError("Empty response from npm view")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return raw.strip().strip('"')
        if isinstance(parsed, str):
            return parsed
        if isinstance(parsed, list):
            versions = [str(value) for value in parsed if isinstance(value, str) and value]
            if range_spec:
                latest = max_satisfying(versions, range_spec)
                if latest:
                    return latest
            if versions:
                return sorted(versions, key=lambda version: version)[-1]
        raise RuntimeError("Unexpected response from npm view")

    async def _npm_has_available_update(self, source: NpmSource, installed_path: str) -> bool:
        installed_version = self._get_installed_npm_version(installed_path)
        if not installed_version:
            return False
        try:
            package_spec = source.spec if source.version else source.name
            latest_version = await self._get_latest_npm_version(package_spec, source.range)
        except Exception:
            return False
        return latest_version != installed_version

    async def _git_has_available_update(self, installed_path: str) -> bool:
        if not os.path.exists(os.path.join(installed_path, ".git")):
            return False
        try:
            await self._run_command(
                "git", ["fetch", "--quiet"], cwd=installed_path, timeout_ms=NETWORK_TIMEOUT_MS
            )
            local = await self._run_command_capture(
                "git",
                ["rev-parse", "HEAD"],
                cwd=installed_path,
                timeout_ms=NETWORK_TIMEOUT_MS,
            )
            remote = await self._run_command_capture(
                "git",
                ["rev-parse", "@{upstream}"],
                cwd=installed_path,
                timeout_ms=NETWORK_TIMEOUT_MS,
            )
            return local != remote
        except Exception:
            return False

    async def _update_git(self, source: GitSource, scope: SourceScope) -> None:
        target_dir = self._get_git_install_path(source, scope)
        if not os.path.exists(target_dir):
            await self.install_git(source, scope)
            return
        await self._run_command(
            "git", ["fetch", "--all", "--prune"], cwd=target_dir, timeout_ms=NETWORK_TIMEOUT_MS
        )
        if source.ref:
            await self._run_command(
                "git",
                ["checkout", source.ref],
                cwd=target_dir,
                timeout_ms=NETWORK_TIMEOUT_MS,
            )
            await self._run_command(
                "git",
                ["reset", "--hard", f"origin/{source.ref}"],
                cwd=target_dir,
                timeout_ms=NETWORK_TIMEOUT_MS,
            )
        else:
            await self._run_command(
                "git",
                ["pull", "--ff-only"],
                cwd=target_dir,
                timeout_ms=NETWORK_TIMEOUT_MS,
            )
        package_json_path = os.path.join(target_dir, "package.json")
        if os.path.exists(package_json_path):
            await self._run_npm_command(self._get_git_dependency_install_args(), cwd=target_dir)

    async def check_for_available_updates(self) -> list[PackageUpdate]:
        if self._is_offline_mode_enabled():
            return []
        global_settings = self._settings_manager.get_global_settings()
        project_settings = self._settings_manager.get_project_settings()
        all_packages: list[tuple[PackageSource, SourceScope]] = []
        for package in project_settings.get("packages") or []:
            all_packages.append((package, "project"))
        for package in global_settings.get("packages") or []:
            all_packages.append((package, "user"))
        package_sources = self._dedupe_packages(all_packages)
        updates: list[PackageUpdate] = []
        for package, scope in package_sources:
            if scope == "temporary":
                continue
            source = self._package_source_string(package)
            parsed = parse_source(source)
            if isinstance(parsed, LocalSource) or (isinstance(parsed, NpmSource) and parsed.pinned):
                continue
            if isinstance(parsed, NpmSource):
                installed_path = self._get_npm_install_path(parsed, scope)
                if not os.path.exists(installed_path):
                    continue
                if not await self._npm_has_available_update(parsed, installed_path):
                    continue
                updates.append(
                    PackageUpdate(
                        source=source,
                        display_name=parsed.name,
                        type="npm",
                        scope=scope,
                    )
                )
                continue
            if isinstance(parsed, GitSource):
                installed_path = self._get_git_install_path(parsed, scope)
                if not os.path.exists(installed_path):
                    continue
                if not await self._git_has_available_update(installed_path):
                    continue
                updates.append(
                    PackageUpdate(
                        source=source,
                        display_name=f"{parsed.host}/{parsed.path}",
                        type="git",
                        scope=scope,
                    )
                )
        return updates

    async def update(self, source: str | None = None) -> None:
        if self._is_offline_mode_enabled():
            return
        global_settings = self._settings_manager.get_global_settings()
        project_settings = self._settings_manager.get_project_settings()
        identity = self._get_package_identity(source) if source else None
        matched = False
        update_sources: list[tuple[str, SourceScope]] = []
        for package in global_settings.get("packages") or []:
            source_str = self._package_source_string(package)
            if identity and self._get_package_identity(source_str, "user") != identity:
                continue
            matched = True
            update_sources.append((source_str, "user"))
        for package in project_settings.get("packages") or []:
            source_str = self._package_source_string(package)
            if identity and self._get_package_identity(source_str, "project") != identity:
                continue
            matched = True
            update_sources.append((source_str, "project"))
        if source and not matched:
            raise ValueError(f"No matching configured package for source: {source}")
        for source_str, scope in update_sources:
            parsed = parse_source(source_str)
            if isinstance(parsed, NpmSource) and not parsed.pinned:
                self._emit_progress(
                    {
                        "type": "start",
                        "action": "update",
                        "source": source_str,
                        "message": f"Updating {source_str}...",
                    }
                )
                await self.install_npm(
                    NpmSource(spec=f"{parsed.name}@latest", name=parsed.name, pinned=False),
                    scope,
                )
                self._emit_progress({"type": "complete", "action": "update", "source": source_str})
            elif isinstance(parsed, GitSource):
                self._emit_progress(
                    {
                        "type": "start",
                        "action": "update",
                        "source": source_str,
                        "message": f"Updating {source_str}...",
                    }
                )
                await self._update_git(parsed, scope)
                self._emit_progress({"type": "complete", "action": "update", "source": source_str})
