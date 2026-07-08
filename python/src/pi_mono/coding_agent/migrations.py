"""One-time migrations that run on startup."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass

from pi_mono.config import CONFIG_DIR_NAME, get_agent_dir, get_bin_dir
from pi_mono.coding_agent.core.keybindings import migrate_keybindings_config

MIGRATION_GUIDE_URL = "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration"
EXTENSIONS_DOC_URL = (
    "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md"
)


def _write_stderr(text: str) -> None:
    print(text, file=sys.stderr)


@dataclass
class MigrationResult:
    migrated_auth_providers: list[str]
    deprecation_warnings: list[str]


def migrate_auth_to_auth_json() -> list[str]:
    agent_dir = str(get_agent_dir())
    auth_path = os.path.join(agent_dir, "auth.json")
    oauth_path = os.path.join(agent_dir, "oauth.json")
    settings_path = os.path.join(agent_dir, "settings.json")

    if os.path.exists(auth_path):
        return []

    migrated: dict[str, object] = {}
    providers: list[str] = []

    if os.path.exists(oauth_path):
        try:
            oauth = json.loads(open(oauth_path, encoding="utf-8").read())
            for provider, cred in oauth.items():
                migrated[provider] = {"type": "oauth", **(cred if isinstance(cred, dict) else {})}
                providers.append(provider)
            os.rename(oauth_path, f"{oauth_path}.migrated")
        except OSError:
            pass
        except json.JSONDecodeError:
            pass

    if os.path.exists(settings_path):
        try:
            settings = json.loads(open(settings_path, encoding="utf-8").read())
            api_keys = settings.get("apiKeys")
            if isinstance(api_keys, dict):
                for provider, key in api_keys.items():
                    if provider not in migrated and isinstance(key, str):
                        migrated[provider] = {"type": "api_key", "key": key}
                        providers.append(provider)
                del settings["apiKeys"]
                with open(settings_path, "w", encoding="utf-8") as handle:
                    json.dump(settings, handle, indent=2)
                    handle.write("\n")
        except (OSError, json.JSONDecodeError):
            pass

    if migrated:
        os.makedirs(os.path.dirname(auth_path), exist_ok=True)
        with open(auth_path, "w", encoding="utf-8") as handle:
            json.dump(migrated, handle, indent=2)
            handle.write("\n")
        os.chmod(auth_path, 0o600)

    return providers


def migrate_sessions_from_agent_root() -> None:
    agent_dir = str(get_agent_dir())
    try:
        files = [
            os.path.join(agent_dir, name)
            for name in os.listdir(agent_dir)
            if name.endswith(".jsonl")
        ]
    except OSError:
        return

    for file_path in files:
        try:
            with open(file_path, encoding="utf-8") as handle:
                first_line = handle.readline()
            if not first_line.strip():
                continue
            header = json.loads(first_line)
            if header.get("type") != "session" or not header.get("cwd"):
                continue
            cwd = str(header["cwd"])
            stripped = cwd.lstrip("/\\")
            encoded = re.sub(r"[/\\:]", "-", stripped)
            safe_path = f"--{encoded}--"
            correct_dir = os.path.join(agent_dir, "sessions", safe_path)
            os.makedirs(correct_dir, exist_ok=True)
            destination = os.path.join(correct_dir, os.path.basename(file_path))
            if os.path.exists(destination):
                continue
            shutil.move(file_path, destination)
        except (OSError, json.JSONDecodeError):
            continue


def _migrate_commands_to_prompts(base_dir: str, label: str) -> bool:
    commands_dir = os.path.join(base_dir, "commands")
    prompts_dir = os.path.join(base_dir, "prompts")
    if os.path.exists(commands_dir) and not os.path.exists(prompts_dir):
        try:
            os.rename(commands_dir, prompts_dir)
            print(f"Migrated {label} commands/ -> prompts/")
            return True
        except OSError as error:
            print(f"Warning: Could not migrate {label} commands/ to prompts/: {error}")
    return False


def migrate_keybindings_config_file() -> None:
    config_path = os.path.join(str(get_agent_dir()), "keybindings.json")
    if not os.path.exists(config_path):
        return
    try:
        parsed = json.loads(open(config_path, encoding="utf-8").read())
        if not isinstance(parsed, dict):
            return
        config, migrated = migrate_keybindings_config(parsed)
        if not migrated:
            return
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
            handle.write("\n")
    except (OSError, json.JSONDecodeError):
        return


def migrate_tools_to_bin() -> None:
    tools_dir = os.path.join(str(get_agent_dir()), "tools")
    bin_dir = str(get_bin_dir())
    if not os.path.isdir(tools_dir):
        return

    moved_any = False
    for binary in ("fd", "rg", "fd.exe", "rg.exe"):
        old_path = os.path.join(tools_dir, binary)
        new_path = os.path.join(bin_dir, binary)
        if not os.path.exists(old_path):
            continue
        os.makedirs(bin_dir, exist_ok=True)
        if not os.path.exists(new_path):
            try:
                shutil.move(old_path, new_path)
                moved_any = True
            except OSError:
                pass
        else:
            try:
                os.remove(old_path)
            except OSError:
                pass
    if moved_any:
        print("Migrated managed binaries tools/ -> bin/")


def _check_deprecated_extension_dirs(base_dir: str, label: str) -> list[str]:
    hooks_dir = os.path.join(base_dir, "hooks")
    tools_dir = os.path.join(base_dir, "tools")
    warnings: list[str] = []

    if os.path.isdir(hooks_dir):
        warnings.append(f"{label} hooks/ directory found. Hooks have been renamed to extensions.")

    if os.path.isdir(tools_dir):
        try:
            entries = os.listdir(tools_dir)
            custom_tools = [
                entry
                for entry in entries
                if entry.lower() not in {"fd", "rg", "fd.exe", "rg.exe"}
                and not entry.startswith(".")
            ]
            if custom_tools:
                warnings.append(
                    f"{label} tools/ directory contains custom tools. "
                    "Custom tools have been merged into extensions."
                )
        except OSError:
            pass

    return warnings


def migrate_extension_system(cwd: str) -> list[str]:
    agent_dir = str(get_agent_dir())
    project_dir = os.path.join(cwd, CONFIG_DIR_NAME)
    _migrate_commands_to_prompts(agent_dir, "Global")
    _migrate_commands_to_prompts(project_dir, "Project")
    return [
        *_check_deprecated_extension_dirs(agent_dir, "Global"),
        *_check_deprecated_extension_dirs(project_dir, "Project"),
    ]


def run_migrations(cwd: str) -> MigrationResult:
    migrated_auth_providers = migrate_auth_to_auth_json()
    migrate_sessions_from_agent_root()
    migrate_tools_to_bin()
    migrate_keybindings_config_file()
    deprecation_warnings = migrate_extension_system(cwd)
    return MigrationResult(
        migrated_auth_providers=migrated_auth_providers,
        deprecation_warnings=deprecation_warnings,
    )


async def show_deprecation_warnings(warnings: list[str]) -> None:
    """Print deprecation warnings and wait for keypress in interactive TTY sessions."""
    if not warnings:
        return

    for warning in warnings:
        _write_stderr(f"Warning: {warning}")
    _write_stderr("\nMove your extensions to the extensions/ directory.")
    _write_stderr(f"Migration guide: {MIGRATION_GUIDE_URL}")
    _write_stderr(f"Documentation: {EXTENSIONS_DOC_URL}")
    _write_stderr("\nPress any key to continue...")

    if not sys.stdin.isatty():
        return

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: sys.stdin.read(1))
    _write_stderr("")
