import json
import shutil
from pathlib import Path
import pytest

from pi_mono.core.settings_manager import SettingsManager
from pi_mono.core.http_dispatcher import DEFAULT_HTTP_IDLE_TIMEOUT_MS


@pytest.fixture
def test_dirs(tmp_path):
    agent_dir = tmp_path / "agent"
    project_dir = tmp_path / "project"
    agent_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / ".pi").mkdir(parents=True, exist_ok=True)
    return {
        "agent_dir": str(agent_dir),
        "project_dir": str(project_dir),
        "global_settings_path": str(agent_dir / "settings.json"),
        "project_settings_path": str(project_dir / ".pi" / "settings.json"),
    }


@pytest.mark.anyio
async def test_preserve_enabled_models_when_changing_thinking_level(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark", "defaultModel": "claude-sonnet"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    # Simulate user editing settings.json externally to add enabledModels
    with open(global_path, "r", encoding="utf-8") as f:
        current_settings = json.load(f)
    current_settings["enabledModels"] = ["claude-opus-4-5", "gpt-5.2-codex"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump(current_settings, f, indent=2)

    # User changes thinking level
    manager.set_default_thinking_level("high")
    await manager.flush()

    # Verify enabledModels is preserved
    with open(global_path, "r", encoding="utf-8") as f:
        saved_settings = json.load(f)
    assert saved_settings["enabledModels"] == ["claude-opus-4-5", "gpt-5.2-codex"]
    assert saved_settings["defaultThinkingLevel"] == "high"
    assert saved_settings["theme"] == "dark"
    assert saved_settings["defaultModel"] == "claude-sonnet"


@pytest.mark.anyio
async def test_preserve_custom_settings_when_changing_theme(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"defaultModel": "claude-sonnet"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    # User adds custom settings externally
    with open(global_path, "r", encoding="utf-8") as f:
        current_settings = json.load(f)
    current_settings["shellPath"] = "/bin/zsh"
    current_settings["extensions"] = ["/path/to/extension.ts"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump(current_settings, f, indent=2)

    # User changes theme
    manager.set_theme("light")
    await manager.flush()

    # Verify all settings preserved
    with open(global_path, "r", encoding="utf-8") as f:
        saved_settings = json.load(f)
    assert saved_settings["shellPath"] == "/bin/zsh"
    assert saved_settings["extensions"] == ["/path/to/extension.ts"]
    assert saved_settings["theme"] == "light"


@pytest.mark.anyio
async def test_let_in_memory_changes_override_file_changes_for_same_key(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    # User externally sets thinking level to "low"
    with open(global_path, "r", encoding="utf-8") as f:
        current_settings = json.load(f)
    current_settings["defaultThinkingLevel"] = "low"
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump(current_settings, f, indent=2)

    # But then changes it via UI to "high"
    manager.set_default_thinking_level("high")
    await manager.flush()

    # In-memory change should win
    with open(global_path, "r", encoding="utf-8") as f:
        saved_settings = json.load(f)
    assert saved_settings["defaultThinkingLevel"] == "high"


def test_packages_migration_local_only_extensions(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"extensions": ["/local/ext.ts", "./relative/ext.ts"]}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    assert manager.get_packages() == []
    assert manager.get_extension_paths() == ["/local/ext.ts", "./relative/ext.ts"]


def test_packages_migration_filtering_objects(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "packages": [
                    "npm:simple-pkg",
                    {
                        "source": "npm:shitty-extensions",
                        "extensions": ["extensions/oracle.ts"],
                        "skills": [],
                    },
                ]
            },
            f,
        )

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    packages = manager.get_packages()
    assert len(packages) == 2
    assert packages[0] == "npm:simple-pkg"
    assert packages[1] == {
        "source": "npm:shitty-extensions",
        "extensions": ["extensions/oracle.ts"],
        "skills": [],
    }


@pytest.mark.anyio
async def test_reload_global_settings_from_disk(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark", "extensions": ["/before.ts"]}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    with open(global_path, "w", encoding="utf-8") as f:
        json.dump(
            {"theme": "light", "extensions": ["/after.ts"], "defaultModel": "claude-sonnet"},
            f,
        )

    await manager.reload()

    assert manager.get_theme() == "light"
    assert manager.get_extension_paths() == ["/after.ts"]
    assert manager.get_default_model() == "claude-sonnet"


@pytest.mark.anyio
async def test_keep_previous_settings_when_file_is_invalid(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    with open(global_path, "w", encoding="utf-8") as f:
        f.write("{ invalid json")

    await manager.reload()

    assert manager.get_theme() == "dark"


def test_collect_and_clear_load_errors_via_drain_errors(test_dirs):
    global_path = test_dirs["global_settings_path"]
    project_path = test_dirs["project_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        f.write("{ invalid global json")
    with open(project_path, "w", encoding="utf-8") as f:
        f.write("{ invalid project json")

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    errors = manager.drain_errors()

    assert len(errors) == 2
    scopes = sorted([e["scope"] for e in errors])
    assert scopes == ["global", "project"]
    assert manager.drain_errors() == []


def test_project_settings_directory_creation_only_reading(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark"}, f)

    # Delete project .pi dir
    project_pi_dir = Path(test_dirs["project_dir"]) / ".pi"
    if project_pi_dir.exists():
        shutil.rmtree(project_pi_dir)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    assert not project_pi_dir.exists()
    assert manager.get_theme() == "dark"


@pytest.mark.anyio
async def test_project_settings_directory_creation_on_writing(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark"}, f)

    # Delete project .pi dir
    project_pi_dir = Path(test_dirs["project_dir"]) / ".pi"
    if project_pi_dir.exists():
        shutil.rmtree(project_pi_dir)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])

    assert not project_pi_dir.exists()

    manager.set_project_packages([{"source": "npm:test-pkg"}])
    await manager.flush()

    assert project_pi_dir.exists()
    assert (project_pi_dir / "settings.json").exists()


def test_http_idle_timeout_ms_default(test_dirs):
    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_http_idle_timeout_ms() == DEFAULT_HTTP_IDLE_TIMEOUT_MS


def test_http_idle_timeout_ms_merged(test_dirs):
    global_path = test_dirs["global_settings_path"]
    project_path = test_dirs["project_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"httpIdleTimeoutMs": 300000}, f)
    with open(project_path, "w", encoding="utf-8") as f:
        json.dump({"httpIdleTimeoutMs": 0}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_http_idle_timeout_ms() == 0


def test_http_idle_timeout_ms_invalid(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"httpIdleTimeoutMs": -1}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    with pytest.raises(ValueError, match="Invalid httpIdleTimeoutMs setting"):
        manager.get_http_idle_timeout_ms()


def test_shell_command_prefix_load(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"shellCommandPrefix": "shopt -s expand_aliases"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_shell_command_prefix() == "shopt -s expand_aliases"


def test_shell_command_prefix_none(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_shell_command_prefix() is None


@pytest.mark.anyio
async def test_shell_command_prefix_preserved_on_save(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"shellCommandPrefix": "shopt -s expand_aliases"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    manager.set_theme("light")
    await manager.flush()

    with open(global_path, "r", encoding="utf-8") as f:
        saved = json.load(f)
    assert saved["shellCommandPrefix"] == "shopt -s expand_aliases"
    assert saved["theme"] == "light"


def test_get_session_dir_none(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"theme": "dark"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_session_dir() is None


def test_get_session_dir_global(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"sessionDir": "/tmp/sessions"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_session_dir() == "/tmp/sessions"


def test_get_session_dir_project_override(test_dirs):
    global_path = test_dirs["global_settings_path"]
    project_path = test_dirs["project_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"sessionDir": "/global/sessions"}, f)
    with open(project_path, "w", encoding="utf-8") as f:
        json.dump({"sessionDir": "./sessions"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    assert manager.get_session_dir() == "./sessions"


def test_get_session_dir_tilde_expansion(test_dirs):
    global_path = test_dirs["global_settings_path"]
    with open(global_path, "w", encoding="utf-8") as f:
        json.dump({"sessionDir": "~/sessions"}, f)

    manager = SettingsManager.create(test_dirs["project_dir"], test_dirs["agent_dir"])
    from pi_mono.utils.paths import normalize_path

    assert manager.get_session_dir() == normalize_path("~/sessions")


def test_settings_migrations():
    # queueMode -> steeringMode
    migrated1 = SettingsManager.migrate_settings({"queueMode": "all"})
    assert migrated1.get("steeringMode") == "all"
    assert "queueMode" not in migrated1

    # websockets -> transport
    migrated2 = SettingsManager.migrate_settings({"websockets": True})
    assert migrated2.get("transport") == "websocket"
    assert "websockets" not in migrated2

    migrated3 = SettingsManager.migrate_settings({"websockets": False})
    assert migrated3.get("transport") == "sse"
    assert "websockets" not in migrated3

    # skills dict -> skills list & enableSkillCommands
    migrated4 = SettingsManager.migrate_settings(
        {
            "skills": {
                "enableSkillCommands": False,
                "customDirectories": ["/custom/dir"],
            }
        }
    )
    assert migrated4.get("enableSkillCommands") is False
    assert migrated4.get("skills") == ["/custom/dir"]

    # retry delay
    migrated5 = SettingsManager.migrate_settings(
        {
            "retry": {
                "maxDelayMs": 5000,
                "provider": {"timeoutMs": 1000},
            }
        }
    )
    assert migrated5.get("retry")["provider"]["maxRetryDelayMs"] == 5000
    assert "maxDelayMs" not in migrated5.get("retry")


def test_in_memory():
    manager = SettingsManager.in_memory({"theme": "dark"})
    assert manager.get_theme() == "dark"
    manager.set_theme("light")
    assert manager.get_theme() == "light"
