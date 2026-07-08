import pytest
from unittest.mock import AsyncMock, patch

from pi_mono.coding_agent.package_manager_cli import handle_package_command, parse_package_command
from pi_mono.core.settings_manager import SettingsManager


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    agent_dir = tmp_path / "agent"
    project_dir = tmp_path / "project"
    agent_dir.mkdir()
    (project_dir / ".pi").mkdir(parents=True)
    monkeypatch.chdir(project_dir)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(agent_dir))
    return {
        "agent_dir": agent_dir,
        "project_dir": project_dir,
        "source_dir": tmp_path / "pkg",
    }


def test_parse_package_command_install_local_flag():
    options = parse_package_command(["install", "./ext", "--local"])
    assert options is not None
    assert options.command == "install"
    assert options.source == "./ext"
    assert options.local is True


def test_parse_package_command_uninstall_alias():
    options = parse_package_command(["uninstall", "./ext"])
    assert options is not None
    assert options.command == "remove"


def test_parse_package_command_unknown_command():
    assert parse_package_command(["foo"]) is None


@pytest.mark.anyio
async def test_handle_package_command_install_and_list(cli_env):
    cli_env["source_dir"].mkdir()
    (cli_env["source_dir"] / "README.md").write_text("pkg\n", encoding="utf-8")

    handled = await handle_package_command(["install", str(cli_env["source_dir"])])
    assert handled is True

    configured = SettingsManager.create(str(cli_env["project_dir"]), str(cli_env["agent_dir"]))
    packages = configured.get_packages()
    assert packages

    handled = await handle_package_command(["list"])
    assert handled is True


@pytest.mark.anyio
async def test_handle_package_command_remove(cli_env):
    cli_env["source_dir"].mkdir()
    await handle_package_command(["install", str(cli_env["source_dir"])])
    handled = await handle_package_command(["remove", str(cli_env["source_dir"])])
    assert handled is True

    manager = SettingsManager.create(str(cli_env["project_dir"]), str(cli_env["agent_dir"]))
    assert manager.get_packages() == []


@pytest.mark.anyio
async def test_handle_package_command_update_runs(cli_env, capsys):
    with (
        patch(
            "pi_mono.coding_agent.package_manager_cli._get_self_update_plan",
            new=AsyncMock(return_value={"packageName": "pkg", "shouldRun": True}),
        ),
        patch(
            "pi_mono.coding_agent.package_manager_cli.get_self_update_command",
            return_value={"command": "true", "args": [], "display": "true"},
        ),
        patch("pi_mono.coding_agent.package_manager_cli._run_self_update"),
    ):
        handled = await handle_package_command(["update"])
    assert handled is True
    captured = capsys.readouterr()
    assert "not implemented" not in captured.out.lower()
    assert "Extensions are skipped" in captured.out
