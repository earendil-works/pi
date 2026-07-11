from __future__ import annotations

import asyncio
import copy
import json
import math
import os
import sys
import time
from typing import Any, Callable, Literal, TypedDict, Union, cast

from pi_mono.config import CONFIG_DIR_NAME, get_agent_dir
from pi_mono.utils.paths import normalize_path, resolve_path
from pi_mono.core.http_dispatcher import (
    DEFAULT_HTTP_IDLE_TIMEOUT_MS,
    parse_http_idle_timeout_ms,
)

# =============================================================================
# Settings Type Definitions
# =============================================================================


class CompactionSettings(TypedDict, total=False):
    enabled: bool
    reserveTokens: int
    keepRecentTokens: int


class BranchSummarySettings(TypedDict, total=False):
    reserveTokens: int
    skipPrompt: bool


class ProviderRetrySettings(TypedDict, total=False):
    timeoutMs: int
    maxRetries: int
    maxRetryDelayMs: int


class RetrySettings(TypedDict, total=False):
    enabled: bool
    maxRetries: int
    baseDelayMs: int
    provider: ProviderRetrySettings


class TerminalSettings(TypedDict, total=False):
    showImages: bool
    imageWidthCells: int
    clearOnShrink: bool
    showTerminalProgress: bool


class ImageSettings(TypedDict, total=False):
    autoResize: bool
    blockImages: bool


class ThinkingBudgetsSettings(TypedDict, total=False):
    minimal: int
    low: int
    medium: int
    high: int


class MarkdownSettings(TypedDict, total=False):
    codeBlockIndent: str


class WarningSettings(TypedDict, total=False):
    anthropicExtraUsage: bool


PackageSource = Union[str, dict[str, Any]]


DefaultProjectTrust = Literal["ask", "always", "never"]


class Settings(TypedDict, total=False):
    lastChangelogVersion: str | None
    defaultProvider: str | None
    defaultModel: str | None
    defaultThinkingLevel: (
        Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"] | None
    )
    transport: Literal["auto", "websocket", "sse"] | None
    steeringMode: Literal["all", "one-at-a-time"] | None
    followUpMode: Literal["all", "one-at-a-time"] | None
    theme: str | None
    compaction: CompactionSettings | None
    branchSummary: BranchSummarySettings | None
    retry: RetrySettings | None
    hideThinkingBlock: bool | None
    showCacheMissNotices: bool | None
    externalEditor: str | None
    shellPath: str | None
    quietStartup: bool | None
    shellCommandPrefix: str | None
    npmCommand: list[str] | None
    collapseChangelog: bool | None
    enableInstallTelemetry: bool | None
    packages: list[PackageSource] | None
    extensions: list[str] | None
    skills: list[str] | None
    prompts: list[str] | None
    themes: list[str] | None
    enableSkillCommands: bool | None
    terminal: TerminalSettings | None
    images: ImageSettings | None
    enabledModels: list[str] | None
    doubleEscapeAction: Literal["fork", "tree", "none"] | None
    treeFilterMode: Literal["default", "no-tools", "user-only", "labeled-only", "all"] | None
    thinkingBudgets: ThinkingBudgetsSettings | None
    editorPaddingX: int | None
    outputPad: Literal[0, 1] | None
    autocompleteMaxVisible: int | None
    showHardwareCursor: bool | None
    markdown: MarkdownSettings | None
    warnings: WarningSettings | None
    sessionDir: str | None
    httpIdleTimeoutMs: int | None
    httpProxy: str | None
    websocketConnectTimeoutMs: int | None
    defaultProjectTrust: DefaultProjectTrust | None


# =============================================================================
# Helper Functions
# =============================================================================


def deep_merge_settings(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """Deep merge settings: overrides take precedence, nested dicts merge recursively."""
    result = copy.deepcopy(base)

    for key, override_value in overrides.items():
        if override_value is None:
            continue

        base_value = base.get(key)

        if isinstance(override_value, dict) and isinstance(base_value, dict):
            result[key] = deep_merge_settings(base_value, override_value)
        else:
            result[key] = copy.deepcopy(override_value)

    return result


def parse_timeout_setting(value: Any, setting_name: str) -> int | None:
    timeout_ms = parse_http_idle_timeout_ms(value)
    if timeout_ms is not None:
        return timeout_ms
    if value is not None:
        raise ValueError(f"Invalid {setting_name} setting: {value}")
    return None


# =============================================================================
# Atomic File Lock
# =============================================================================


class FileLock:
    def __init__(self, path: str):
        self.lock_dir = f"{path}.lock"
        self.locked = False

    def acquire(self) -> None:
        max_attempts = 10
        delay_seconds = 0.02
        last_error = None

        for attempt in range(1, max_attempts + 1):
            try:
                os.mkdir(self.lock_dir)
                self.locked = True
                return
            except FileExistsError as e:
                last_error = e
                if attempt == max_attempts:
                    raise RuntimeError(
                        f"Failed to acquire settings lock: file is locked ({self.lock_dir})"
                    ) from e
                time.sleep(delay_seconds)
            except Exception as e:
                raise RuntimeError(f"Failed to acquire settings lock: {e}") from e

        raise last_error if last_error else RuntimeError("Failed to acquire settings lock")

    def release(self) -> None:
        if self.locked:
            try:
                os.rmdir(self.lock_dir)
            except Exception:
                pass
            self.locked = False


# =============================================================================
# Settings Storage Backends
# =============================================================================


class SettingsStorage:
    def with_lock(self, scope: str, fn: Callable[[str | None], str | None]) -> None:
        raise NotImplementedError()


class FileSettingsStorage(SettingsStorage):
    def __init__(self, cwd: str, agent_dir: str):
        resolved_cwd = resolve_path(cwd)
        resolved_agent_dir = resolve_path(agent_dir)
        self.global_settings_path = os.path.join(resolved_agent_dir, "settings.json")
        self.project_settings_path = os.path.join(resolved_cwd, CONFIG_DIR_NAME, "settings.json")

    def _acquire_lock_sync_with_retry(self, path: str) -> FileLock:
        lock = FileLock(path)
        lock.acquire()
        return lock

    def with_lock(self, scope: str, fn: Callable[[str | None], str | None]) -> None:
        path = self.global_settings_path if scope == "global" else self.project_settings_path
        directory = os.path.dirname(path)

        lock = None
        try:
            file_exists = os.path.exists(path)
            if file_exists:
                lock = self._acquire_lock_sync_with_retry(path)

            current = None
            if file_exists:
                with open(path, "r", encoding="utf-8") as f:
                    current = f.read()

            next_content = fn(current)
            if next_content is not None:
                if not os.path.exists(directory):
                    os.makedirs(directory, exist_ok=True)
                if not lock:
                    lock = self._acquire_lock_sync_with_retry(path)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(next_content)
        finally:
            if lock:
                lock.release()


class InMemorySettingsStorage(SettingsStorage):
    def __init__(self) -> None:
        self.global_content: str | None = None
        self.project_content: str | None = None

    def with_lock(self, scope: str, fn: Callable[[str | None], str | None]) -> None:
        current = self.global_content if scope == "global" else self.project_content
        next_content = fn(current)
        if next_content is not None:
            if scope == "global":
                self.global_content = next_content
            else:
                self.project_content = next_content


# =============================================================================
# Settings Manager
# =============================================================================


class SettingsManager:
    def __init__(
        self,
        storage: SettingsStorage,
        initial_global: Settings,
        initial_project: Settings,
        global_load_error: Exception | None = None,
        project_load_error: Exception | None = None,
        initial_errors: list[dict[str, Any]] | None = None,
        project_trusted: bool = True,
    ):
        self.storage = storage
        self.global_settings = initial_global
        self.project_settings = initial_project
        self.project_trusted = project_trusted
        self.global_settings_load_error = global_load_error
        self.project_settings_load_error = project_load_error
        self.errors = list(initial_errors) if initial_errors else []
        self.settings = cast(
            Settings,
            deep_merge_settings(
                cast(dict[str, Any], self.global_settings),
                cast(dict[str, Any], self.project_settings),
            ),
        )

        self.modified_fields: set[str] = set()
        self.modified_nested_fields: dict[str, set[str]] = {}
        self.modified_project_fields: set[str] = set()
        self.modified_project_nested_fields: dict[str, set[str]] = {}

        self._write_lock = asyncio.Lock()
        self._write_tasks: list[asyncio.Task[None]] = []

    @staticmethod
    def create(
        cwd: str, agent_dir: str | None = None, *, project_trusted: bool = True
    ) -> SettingsManager:
        """Create a SettingsManager that loads from files."""
        if agent_dir is None:
            agent_dir = str(get_agent_dir())
        storage = FileSettingsStorage(cwd, agent_dir)
        return SettingsManager.from_storage(storage, project_trusted=project_trusted)

    @staticmethod
    def from_storage(storage: SettingsStorage, *, project_trusted: bool = True) -> SettingsManager:
        """Create a SettingsManager from an arbitrary storage backend."""
        global_load = SettingsManager.try_load_from_storage(storage, "global")
        project_load = SettingsManager.try_load_from_storage(storage, "project", project_trusted)
        initial_errors = []
        if global_load["error"]:
            initial_errors.append({"scope": "global", "error": global_load["error"]})
        if project_load["error"]:
            initial_errors.append({"scope": "project", "error": project_load["error"]})

        return SettingsManager(
            storage,
            global_load["settings"],
            project_load["settings"],
            global_load["error"],
            project_load["error"],
            initial_errors,
            project_trusted,
        )

    @staticmethod
    def in_memory(settings: Settings | None = None) -> SettingsManager:
        """Create an in-memory SettingsManager (no file I/O)."""
        storage = InMemorySettingsStorage()
        initial_settings = SettingsManager.migrate_settings(
            cast(dict[str, Any], copy.deepcopy(settings)) if settings else {}
        )
        storage.with_lock("global", lambda current: json.dumps(initial_settings, indent=2))
        return SettingsManager.from_storage(storage)

    @staticmethod
    def load_from_storage(
        storage: SettingsStorage, scope: str, project_trusted: bool = True
    ) -> Settings:
        if scope == "project" and not project_trusted:
            return {}
        content = None

        def callback(current: str | None) -> str | None:
            nonlocal content
            content = current
            return None

        storage.with_lock(scope, callback)
        if not content:
            return {}
        return SettingsManager.migrate_settings(json.loads(content))

    @staticmethod
    def try_load_from_storage(
        storage: SettingsStorage, scope: str, project_trusted: bool = True
    ) -> dict[str, Any]:
        try:
            return {
                "settings": SettingsManager.load_from_storage(storage, scope, project_trusted),
                "error": None,
            }
        except Exception as e:
            return {"settings": {}, "error": e}

    @staticmethod
    def migrate_settings(settings: dict[str, Any]) -> Settings:
        """Migrate old settings format to new format."""
        migrated = dict(settings)

        # Migrate queueMode -> steeringMode
        if "queueMode" in migrated and "steeringMode" not in migrated:
            migrated["steeringMode"] = migrated["queueMode"]
            migrated.pop("queueMode", None)

        # Migrate legacy websockets boolean -> transport enum
        if "transport" not in migrated and isinstance(migrated.get("websockets"), bool):
            migrated["transport"] = "websocket" if migrated["websockets"] else "sse"
            migrated.pop("websockets", None)

        # Migrate old skills object format to new array format
        if "skills" in migrated and isinstance(migrated["skills"], dict):
            skills_settings = migrated["skills"]
            if "enableSkillCommands" in skills_settings and "enableSkillCommands" not in migrated:
                migrated["enableSkillCommands"] = skills_settings["enableSkillCommands"]
            custom_dirs = skills_settings.get("customDirectories")
            if isinstance(custom_dirs, list) and len(custom_dirs) > 0:
                migrated["skills"] = custom_dirs
            else:
                migrated.pop("skills", None)

        # Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
        if "retry" in migrated and isinstance(migrated["retry"], dict):
            retry_settings = dict(migrated["retry"])
            provider_settings = retry_settings.get("provider")
            if isinstance(provider_settings, dict):
                provider_settings = dict(provider_settings)
            else:
                provider_settings = {}

            max_delay = retry_settings.get("maxDelayMs")
            if isinstance(max_delay, (int, float)):
                if "maxRetryDelayMs" not in provider_settings:
                    provider_settings["maxRetryDelayMs"] = max_delay
                retry_settings["provider"] = provider_settings
                retry_settings.pop("maxDelayMs", None)

            migrated["retry"] = retry_settings

        return migrated  # type: ignore[return-value]

    def get_global_settings(self) -> Settings:
        return copy.deepcopy(self.global_settings)

    def get_project_settings(self) -> Settings:
        return copy.deepcopy(self.project_settings)

    def is_project_trusted(self) -> bool:
        return self.project_trusted

    def set_project_trusted(self, trusted: bool) -> None:
        if self.project_trusted == trusted:
            return
        self.project_trusted = trusted
        self.modified_project_fields.clear()
        self.modified_project_nested_fields.clear()
        if not trusted:
            self.project_settings = {}
            self.project_settings_load_error = None
            self.settings = cast(
                Settings,
                deep_merge_settings(
                    cast(dict[str, Any], self.global_settings),
                    cast(dict[str, Any], self.project_settings),
                ),
            )
            return
        project_load = SettingsManager.try_load_from_storage(self.storage, "project", trusted)
        self.project_settings = project_load["settings"]
        self.project_settings_load_error = project_load["error"]
        if project_load["error"]:
            self._record_error("project", project_load["error"])
        self.settings = cast(
            Settings,
            deep_merge_settings(
                cast(dict[str, Any], self.global_settings),
                cast(dict[str, Any], self.project_settings),
            ),
        )

    def get_default_project_trust(self) -> DefaultProjectTrust:
        value = self.global_settings.get("defaultProjectTrust")
        if value in ("ask", "always", "never"):
            return value
        return "ask"

    def set_default_project_trust(self, default_project_trust: DefaultProjectTrust) -> None:
        self.global_settings["defaultProjectTrust"] = default_project_trust
        self._mark_modified("defaultProjectTrust")

    async def reload(self) -> None:
        await self.flush()
        global_load = SettingsManager.try_load_from_storage(self.storage, "global")
        if not global_load["error"]:
            self.global_settings = global_load["settings"]
            self.global_settings_load_error = None
        else:
            self.global_settings_load_error = global_load["error"]
            self._record_error("global", global_load["error"])

        self.modified_fields.clear()
        self.modified_nested_fields.clear()
        self.modified_project_fields.clear()
        self.modified_project_nested_fields.clear()

        project_load = SettingsManager.try_load_from_storage(
            self.storage, "project", self.project_trusted
        )
        if not project_load["error"]:
            self.project_settings = project_load["settings"]
            self.project_settings_load_error = None
        else:
            self.project_settings_load_error = project_load["error"]
            self._record_error("project", project_load["error"])

        self.settings = cast(
            Settings,
            deep_merge_settings(
                cast(dict[str, Any], self.global_settings),
                cast(dict[str, Any], self.project_settings),
            ),
        )

    def apply_overrides(self, overrides: Settings) -> None:
        """Apply additional overrides on top of current settings."""
        self.settings = cast(
            Settings,
            deep_merge_settings(
                cast(dict[str, Any], self.settings),
                cast(dict[str, Any], overrides),
            ),
        )

    def _mark_modified(self, field: str, nested_key: str | None = None) -> None:
        self.modified_fields.add(field)
        if nested_key:
            if field not in self.modified_nested_fields:
                self.modified_nested_fields[field] = set()
            self.modified_nested_fields[field].add(nested_key)

    def _mark_project_modified(self, field: str, nested_key: str | None = None) -> None:
        self.modified_project_fields.add(field)
        if nested_key:
            if field not in self.modified_project_nested_fields:
                self.modified_project_nested_fields[field] = set()
            self.modified_project_nested_fields[field].add(nested_key)

    def _record_error(self, scope: str, error: Any) -> None:
        err = error if isinstance(error, Exception) else Exception(str(error))
        self.errors.append({"scope": scope, "error": err})

    def _clear_modified_scope(self, scope: str) -> None:
        if scope == "global":
            self.modified_fields.clear()
            self.modified_nested_fields.clear()
        else:
            self.modified_project_fields.clear()
            self.modified_project_nested_fields.clear()

    def _enqueue_write(self, scope: str, task: Callable[[], None]) -> None:
        try:
            loop = asyncio.get_running_loop()

            async def run_task() -> None:
                async with self._write_lock:
                    try:
                        task()
                        self._clear_modified_scope(scope)
                    except Exception as e:
                        self._record_error(scope, e)

            coro_task = loop.create_task(run_task())
            self._write_tasks.append(coro_task)
        except RuntimeError:
            try:
                task()
                self._clear_modified_scope(scope)
            except Exception as e:
                self._record_error(scope, e)

    def _clone_modified_nested_fields(self, source: dict[str, set[str]]) -> dict[str, set[str]]:
        return {key: set(val) for key, val in source.items()}

    def _persist_scoped_settings(
        self,
        scope: str,
        snapshot_settings: Settings,
        modified_fields: set[str],
        modified_nested_fields: dict[str, set[str]],
    ) -> None:
        def callback(current: str | None) -> str | None:
            current_file_settings = (
                SettingsManager.migrate_settings(json.loads(current)) if current else {}
            )
            merged_settings = dict(current_file_settings)
            snapshot_dict = cast(dict[str, Any], snapshot_settings)
            merged_dict = cast(dict[str, Any], merged_settings)

            for field in modified_fields:
                if field not in snapshot_dict:
                    merged_dict.pop(field, None)
                    continue

                value = snapshot_dict[field]
                if field in modified_nested_fields and isinstance(value, dict):
                    nested_modified = modified_nested_fields[field]
                    base_nested = current_file_settings.get(field)
                    if not isinstance(base_nested, dict):
                        base_nested = {}

                    merged_nested = dict(base_nested)
                    for nested_key in nested_modified:
                        if nested_key in value:
                            merged_nested[nested_key] = value[nested_key]
                        else:
                            merged_nested.pop(nested_key, None)
                    merged_dict[field] = merged_nested
                else:
                    merged_dict[field] = value

            return json.dumps(merged_settings, indent=2)

        self.storage.with_lock(scope, callback)

    def save(self) -> None:
        self.settings = cast(
            Settings,
            deep_merge_settings(
                cast(dict[str, Any], self.global_settings),
                cast(dict[str, Any], self.project_settings),
            ),
        )

        if self.global_settings_load_error:
            return

        snapshot_global_settings = copy.deepcopy(self.global_settings)
        modified_fields = set(self.modified_fields)
        modified_nested_fields = self._clone_modified_nested_fields(self.modified_nested_fields)

        self._enqueue_write(
            "global",
            lambda: self._persist_scoped_settings(
                "global", snapshot_global_settings, modified_fields, modified_nested_fields
            ),
        )

    def save_project_settings(self, settings: Settings) -> None:
        self.project_settings = copy.deepcopy(settings)
        self.settings = cast(
            Settings,
            deep_merge_settings(
                cast(dict[str, Any], self.global_settings),
                cast(dict[str, Any], self.project_settings),
            ),
        )

        if self.project_settings_load_error:
            return

        snapshot_project_settings = copy.deepcopy(self.project_settings)
        modified_fields = set(self.modified_project_fields)
        modified_nested_fields = self._clone_modified_nested_fields(
            self.modified_project_nested_fields
        )

        self._enqueue_write(
            "project",
            lambda: self._persist_scoped_settings(
                "project", snapshot_project_settings, modified_fields, modified_nested_fields
            ),
        )

    async def flush(self) -> None:
        if self._write_tasks:
            tasks = list(self._write_tasks)
            self._write_tasks.clear()
            await asyncio.gather(*tasks, return_exceptions=True)

    def drain_errors(self) -> list[dict[str, Any]]:
        drained = list(self.errors)
        self.errors.clear()
        return drained

    # =============================================================================
    # Getters and Setters
    # =============================================================================

    def get_last_changelog_version(self) -> str | None:
        return self.settings.get("lastChangelogVersion")

    def set_last_changelog_version(self, version: str) -> None:
        self.global_settings["lastChangelogVersion"] = version
        self._mark_modified("lastChangelogVersion")
        self.save()

    def get_session_dir(self) -> str | None:
        session_dir = self.settings.get("sessionDir")
        return normalize_path(session_dir) if session_dir else None

    def get_default_provider(self) -> str | None:
        return self.settings.get("defaultProvider")

    def get_default_model(self) -> str | None:
        return self.settings.get("defaultModel")

    def set_default_provider(self, provider: str) -> None:
        self.global_settings["defaultProvider"] = provider
        self._mark_modified("defaultProvider")
        self.save()

    def set_default_model(self, model_id: str) -> None:
        self.global_settings["defaultModel"] = model_id
        self._mark_modified("defaultModel")
        self.save()

    def set_default_model_and_provider(self, provider: str, model_id: str) -> None:
        self.global_settings["defaultProvider"] = provider
        self.global_settings["defaultModel"] = model_id
        self._mark_modified("defaultProvider")
        self._mark_modified("defaultModel")
        self.save()

    def get_steering_mode(self) -> str:
        return self.settings.get("steeringMode") or "one-at-a-time"

    def set_steering_mode(self, mode: Literal["all", "one-at-a-time"]) -> None:
        self.global_settings["steeringMode"] = mode
        self._mark_modified("steeringMode")
        self.save()

    def get_follow_up_mode(self) -> str:
        return self.settings.get("followUpMode") or "one-at-a-time"

    def set_follow_up_mode(self, mode: Literal["all", "one-at-a-time"]) -> None:
        self.global_settings["followUpMode"] = mode
        self._mark_modified("followUpMode")
        self.save()

    def get_theme_setting(self) -> str | None:
        value = self.settings.get("theme")
        return value if isinstance(value, str) else None

    def get_theme(self) -> str | None:
        theme_setting = self.get_theme_setting()
        if theme_setting and "/" in theme_setting:
            return None
        return theme_setting

    def set_theme(self, theme: str) -> None:
        self.global_settings["theme"] = theme
        self._mark_modified("theme")
        self.save()

    def get_default_thinking_level(
        self,
    ) -> Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"] | None:
        return self.settings.get("defaultThinkingLevel")

    def set_default_thinking_level(
        self, level: Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    ) -> None:
        self.global_settings["defaultThinkingLevel"] = level
        self._mark_modified("defaultThinkingLevel")
        self.save()

    def get_transport(self) -> Literal["auto", "websocket", "sse"]:
        return self.settings.get("transport") or "auto"

    def set_transport(self, transport: Literal["auto", "websocket", "sse"]) -> None:
        self.global_settings["transport"] = transport
        self._mark_modified("transport")
        self.save()

    def get_compaction_enabled(self) -> bool:
        compaction = self.settings.get("compaction")
        if compaction and "enabled" in compaction:
            return bool(compaction["enabled"])
        return True

    def set_compaction_enabled(self, enabled: bool) -> None:
        compaction = self.global_settings.get("compaction")
        if not isinstance(compaction, dict):
            compaction = {}
        compaction["enabled"] = enabled
        self.global_settings["compaction"] = compaction
        self._mark_modified("compaction", "enabled")
        self.save()

    def get_compaction_reserve_tokens(self) -> int:
        compaction = self.settings.get("compaction")
        if compaction and "reserveTokens" in compaction:
            return int(compaction["reserveTokens"])
        return 16384

    def get_compaction_keep_recent_tokens(self) -> int:
        compaction = self.settings.get("compaction")
        if compaction and "keepRecentTokens" in compaction:
            return int(compaction["keepRecentTokens"])
        return 20000

    def get_compaction_settings(self) -> dict[str, Any]:
        return {
            "enabled": self.get_compaction_enabled(),
            "reserveTokens": self.get_compaction_reserve_tokens(),
            "keepRecentTokens": self.get_compaction_keep_recent_tokens(),
        }

    def get_branch_summary_settings(self) -> dict[str, Any]:
        bs = self.settings.get("branchSummary") or {}
        return {
            "reserveTokens": (
                bs.get("reserveTokens") if bs.get("reserveTokens") is not None else 16384
            ),
            "skipPrompt": bs.get("skipPrompt") if bs.get("skipPrompt") is not None else False,
        }

    def get_branch_summary_skip_prompt(self) -> bool:
        bs = self.settings.get("branchSummary") or {}
        return bool(bs.get("skipPrompt", False))

    def get_retry_enabled(self) -> bool:
        retry = self.settings.get("retry")
        if retry and "enabled" in retry:
            return bool(retry["enabled"])
        return True

    def set_retry_enabled(self, enabled: bool) -> None:
        retry = self.global_settings.get("retry")
        if not isinstance(retry, dict):
            retry = {}
        retry["enabled"] = enabled
        self.global_settings["retry"] = retry
        self._mark_modified("retry", "enabled")
        self.save()

    def get_retry_settings(self) -> dict[str, Any]:
        retry = self.settings.get("retry") or {}
        return {
            "enabled": self.get_retry_enabled(),
            "maxRetries": retry.get("maxRetries") if retry.get("maxRetries") is not None else 3,
            "baseDelayMs": (
                retry.get("baseDelayMs") if retry.get("baseDelayMs") is not None else 2000
            ),
        }

    def get_http_idle_timeout_ms(self) -> int:
        val = parse_timeout_setting(self.settings.get("httpIdleTimeoutMs"), "httpIdleTimeoutMs")
        return val if val is not None else DEFAULT_HTTP_IDLE_TIMEOUT_MS

    def get_http_proxy(self) -> str | None:
        value = self.settings.get("httpProxy")
        if not isinstance(value, str):
            return None
        trimmed = value.strip()
        return trimmed if trimmed else None

    def set_http_idle_timeout_ms(self, timeout_ms: int) -> None:
        if (
            not isinstance(timeout_ms, (int, float))
            or not math.isfinite(timeout_ms)
            or timeout_ms < 0
        ):
            raise ValueError(f"Invalid httpIdleTimeoutMs setting: {timeout_ms}")
        self.global_settings["httpIdleTimeoutMs"] = int(timeout_ms)
        self._mark_modified("httpIdleTimeoutMs")
        self.save()

    def get_provider_retry_settings(self) -> dict[str, Any]:
        retry = self.settings.get("retry") or {}
        provider = retry.get("provider") or {}
        return {
            "timeoutMs": provider.get("timeoutMs"),
            "maxRetries": provider.get("maxRetries"),
            "maxRetryDelayMs": (
                provider.get("maxRetryDelayMs")
                if provider.get("maxRetryDelayMs") is not None
                else 60000
            ),
        }

    def get_web_socket_connect_timeout_ms(self) -> int | None:
        return parse_timeout_setting(
            self.settings.get("websocketConnectTimeoutMs"), "websocketConnectTimeoutMs"
        )

    def get_websocket_connect_timeout_ms(self) -> int | None:
        return self.get_web_socket_connect_timeout_ms()

    def get_hide_thinking_block(self) -> bool:
        return bool(self.settings.get("hideThinkingBlock", False))

    def set_hide_thinking_block(self, hide: bool) -> None:
        self.global_settings["hideThinkingBlock"] = hide
        self._mark_modified("hideThinkingBlock")
        self.save()

    def get_show_cache_miss_notices(self) -> bool:
        return bool(self.settings.get("showCacheMissNotices", False))

    def set_show_cache_miss_notices(self, show: bool) -> None:
        self.global_settings["showCacheMissNotices"] = show
        self._mark_modified("showCacheMissNotices")
        self.save()

    def get_external_editor_command(self) -> str | None:
        configured = self.settings.get("externalEditor")
        if isinstance(configured, str) and configured.strip() != "":
            return configured
        environment_editor = os.environ.get("VISUAL") or os.environ.get("EDITOR")
        if environment_editor:
            return environment_editor
        return "notepad" if sys.platform == "win32" else "nano"

    def get_shell_path(self) -> str | None:
        shell_path = self.settings.get("shellPath")
        return normalize_path(shell_path) if shell_path else shell_path

    def set_shell_path(self, path: str | None) -> None:
        self.global_settings["shellPath"] = path
        self._mark_modified("shellPath")
        self.save()

    def get_quiet_startup(self) -> bool:
        return bool(self.settings.get("quietStartup", False))

    def set_quiet_startup(self, quiet: bool) -> None:
        self.global_settings["quietStartup"] = quiet
        self._mark_modified("quietStartup")
        self.save()

    def get_shell_command_prefix(self) -> str | None:
        return self.settings.get("shellCommandPrefix")

    def set_shell_command_prefix(self, prefix: str | None) -> None:
        self.global_settings["shellCommandPrefix"] = prefix
        self._mark_modified("shellCommandPrefix")
        self.save()

    def get_npm_command(self) -> list[str] | None:
        cmd = self.settings.get("npmCommand")
        return list(cmd) if cmd is not None else None

    def set_npm_command(self, command: list[str] | None) -> None:
        self.global_settings["npmCommand"] = list(command) if command is not None else None
        self._mark_modified("npmCommand")
        self.save()

    def get_collapse_changelog(self) -> bool:
        return bool(self.settings.get("collapseChangelog", False))

    def set_collapse_changelog(self, collapse: bool) -> None:
        self.global_settings["collapseChangelog"] = collapse
        self._mark_modified("collapseChangelog")
        self.save()

    def get_enable_install_telemetry(self) -> bool:
        return bool(self.settings.get("enableInstallTelemetry", True))

    def set_enable_install_telemetry(self, enabled: bool) -> None:
        self.global_settings["enableInstallTelemetry"] = enabled
        self._mark_modified("enableInstallTelemetry")
        self.save()

    def get_packages(self) -> list[PackageSource]:
        return list(self.settings.get("packages") or [])

    def set_packages(self, packages: list[PackageSource]) -> None:
        self.global_settings["packages"] = packages
        self._mark_modified("packages")
        self.save()

    def set_project_packages(self, packages: list[PackageSource]) -> None:
        project_settings = copy.deepcopy(self.project_settings)
        project_settings["packages"] = packages
        self._mark_project_modified("packages")
        self.save_project_settings(project_settings)

    def get_extension_paths(self) -> list[str]:
        return list(self.settings.get("extensions") or [])

    def set_extension_paths(self, paths: list[str]) -> None:
        self.global_settings["extensions"] = paths
        self._mark_modified("extensions")
        self.save()

    def set_project_extension_paths(self, paths: list[str]) -> None:
        project_settings = copy.deepcopy(self.project_settings)
        project_settings["extensions"] = paths
        self._mark_project_modified("extensions")
        self.save_project_settings(project_settings)

    def get_skill_paths(self) -> list[str]:
        return list(self.settings.get("skills") or [])

    def set_skill_paths(self, paths: list[str]) -> None:
        self.global_settings["skills"] = paths
        self._mark_modified("skills")
        self.save()

    def set_project_skill_paths(self, paths: list[str]) -> None:
        project_settings = copy.deepcopy(self.project_settings)
        project_settings["skills"] = paths
        self._mark_project_modified("skills")
        self.save_project_settings(project_settings)

    def get_prompt_template_paths(self) -> list[str]:
        return list(self.settings.get("prompts") or [])

    def set_prompt_template_paths(self, paths: list[str]) -> None:
        self.global_settings["prompts"] = paths
        self._mark_modified("prompts")
        self.save()

    def set_project_prompt_template_paths(self, paths: list[str]) -> None:
        project_settings = copy.deepcopy(self.project_settings)
        project_settings["prompts"] = paths
        self._mark_project_modified("prompts")
        self.save_project_settings(project_settings)

    def get_theme_paths(self) -> list[str]:
        return list(self.settings.get("themes") or [])

    def set_theme_paths(self, paths: list[str]) -> None:
        self.global_settings["themes"] = paths
        self._mark_modified("themes")
        self.save()

    def set_project_theme_paths(self, paths: list[str]) -> None:
        project_settings = copy.deepcopy(self.project_settings)
        project_settings["themes"] = paths
        self._mark_project_modified("themes")
        self.save_project_settings(project_settings)

    def get_enable_skill_commands(self) -> bool:
        return bool(self.settings.get("enableSkillCommands", True))

    def set_enable_skill_commands(self, enabled: bool) -> None:
        self.global_settings["enableSkillCommands"] = enabled
        self._mark_modified("enableSkillCommands")
        self.save()

    def get_thinking_budgets(self) -> ThinkingBudgetsSettings | None:
        return self.settings.get("thinkingBudgets")

    def get_show_images(self) -> bool:
        terminal = self.settings.get("terminal") or {}
        return bool(terminal.get("showImages", True))

    def set_show_images(self, show: bool) -> None:
        terminal = self.global_settings.get("terminal")
        if not isinstance(terminal, dict):
            terminal = {}
        terminal["showImages"] = show
        self.global_settings["terminal"] = terminal
        self._mark_modified("terminal", "showImages")
        self.save()

    def get_image_width_cells(self) -> int:
        terminal = self.settings.get("terminal") or {}
        width = terminal.get("imageWidthCells")
        if not isinstance(width, (int, float)) or not math.isfinite(width):
            return 60
        return max(1, int(width))

    def set_image_width_cells(self, width: int) -> None:
        terminal = self.global_settings.get("terminal")
        if not isinstance(terminal, dict):
            terminal = {}
        terminal["imageWidthCells"] = max(1, int(width))
        self.global_settings["terminal"] = terminal
        self._mark_modified("terminal", "imageWidthCells")
        self.save()

    def get_clear_on_shrink(self) -> bool:
        terminal = self.settings.get("terminal") or {}
        if terminal.get("clearOnShrink") is not None:
            return bool(terminal["clearOnShrink"])
        return os.environ.get("PI_CLEAR_ON_SHRINK") == "1"

    def set_clear_on_shrink(self, enabled: bool) -> None:
        terminal = self.global_settings.get("terminal")
        if not isinstance(terminal, dict):
            terminal = {}
        terminal["clearOnShrink"] = enabled
        self.global_settings["terminal"] = terminal
        self._mark_modified("terminal", "clearOnShrink")
        self.save()

    def get_show_terminal_progress(self) -> bool:
        terminal = self.settings.get("terminal") or {}
        return bool(terminal.get("showTerminalProgress", False))

    def set_show_terminal_progress(self, enabled: bool) -> None:
        terminal = self.global_settings.get("terminal")
        if not isinstance(terminal, dict):
            terminal = {}
        terminal["showTerminalProgress"] = enabled
        self.global_settings["terminal"] = terminal
        self._mark_modified("terminal", "showTerminalProgress")
        self.save()

    def get_image_auto_resize(self) -> bool:
        images = self.settings.get("images") or {}
        return bool(images.get("autoResize", True))

    def set_image_auto_resize(self, enabled: bool) -> None:
        images = self.global_settings.get("images")
        if not isinstance(images, dict):
            images = {}
        images["autoResize"] = enabled
        self.global_settings["images"] = images
        self._mark_modified("images", "autoResize")
        self.save()

    def get_block_images(self) -> bool:
        images = self.settings.get("images") or {}
        return bool(images.get("blockImages", False))

    def set_block_images(self, blocked: bool) -> None:
        images = self.global_settings.get("images")
        if not isinstance(images, dict):
            images = {}
        images["blockImages"] = blocked
        self.global_settings["images"] = images
        self._mark_modified("images", "blockImages")
        self.save()

    def get_enabled_models(self) -> list[str] | None:
        return self.settings.get("enabledModels")

    def set_enabled_models(self, patterns: list[str] | None) -> None:
        self.global_settings["enabledModels"] = patterns
        self._mark_modified("enabledModels")
        self.save()

    def get_double_escape_action(self) -> Literal["fork", "tree", "none"]:
        return self.settings.get("doubleEscapeAction") or "tree"

    def set_double_escape_action(self, action: Literal["fork", "tree", "none"]) -> None:
        self.global_settings["doubleEscapeAction"] = action
        self._mark_modified("doubleEscapeAction")
        self.save()

    def get_tree_filter_mode(
        self,
    ) -> Literal["default", "no-tools", "user-only", "labeled-only", "all"]:
        mode = self.settings.get("treeFilterMode")
        valid = ["default", "no-tools", "user-only", "labeled-only", "all"]
        return mode if mode in valid else "default"

    def set_tree_filter_mode(
        self, mode: Literal["default", "no-tools", "user-only", "labeled-only", "all"]
    ) -> None:
        self.global_settings["treeFilterMode"] = mode
        self._mark_modified("treeFilterMode")
        self.save()

    def get_show_hardware_cursor(self) -> bool:
        if self.settings.get("showHardwareCursor") is not None:
            return bool(self.settings["showHardwareCursor"])
        return os.environ.get("PI_HARDWARE_CURSOR") == "1"

    def set_show_hardware_cursor(self, enabled: bool) -> None:
        self.global_settings["showHardwareCursor"] = enabled
        self._mark_modified("showHardwareCursor")
        self.save()

    def get_editor_padding_x(self) -> int:
        return self.settings.get("editorPaddingX") or 0

    def set_editor_padding_x(self, padding: int) -> None:
        self.global_settings["editorPaddingX"] = max(0, min(3, int(padding)))
        self._mark_modified("editorPaddingX")
        self.save()

    def get_output_pad(self) -> Literal[0, 1]:
        return 0 if self.settings.get("outputPad") == 0 else 1

    def set_output_pad(self, padding: Literal[0, 1]) -> None:
        self.global_settings["outputPad"] = padding
        self._mark_modified("outputPad")
        self.save()

    def get_autocomplete_max_visible(self) -> int:
        return self.settings.get("autocompleteMaxVisible") or 5

    def set_autocomplete_max_visible(self, max_visible: int) -> None:
        self.global_settings["autocompleteMaxVisible"] = max(3, min(20, int(max_visible)))
        self._mark_modified("autocompleteMaxVisible")
        self.save()

    def get_code_block_indent(self) -> str:
        markdown = self.settings.get("markdown") or {}
        return markdown.get("codeBlockIndent") or "  "

    def get_warnings(self) -> WarningSettings:
        return cast(WarningSettings, self.settings.get("warnings") or {})

    def set_warnings(self, warnings: WarningSettings) -> None:
        self.global_settings["warnings"] = cast(WarningSettings, dict(warnings))
        self._mark_modified("warnings")
        self.save()
