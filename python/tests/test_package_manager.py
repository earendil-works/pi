import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pi_mono.coding_agent.core.package_manager import (
    DefaultPackageManager,
    NpmSource,
    parse_npm_spec,
    parse_source,
)
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.utils.git import GitSource


@pytest.fixture
def package_env(tmp_path):
    agent_dir = tmp_path / "agent"
    project_dir = tmp_path / "project"
    agent_dir.mkdir()
    (project_dir / ".pi").mkdir(parents=True)
    return {
        "agent_dir": str(agent_dir),
        "project_dir": str(project_dir),
        "global_settings_path": agent_dir / "settings.json",
        "project_settings_path": project_dir / ".pi" / "settings.json",
    }


def test_parse_source_local_and_file_url(tmp_path):
    local_dir = tmp_path / "ext"
    local_dir.mkdir()
    parsed = parse_source(str(local_dir))
    assert parsed.type == "local"

    file_url = parse_source(f"file://{local_dir}")
    assert file_url.type == "local"
    assert os.path.basename(file_url.path) == local_dir.name


def test_parse_source_npm():
    parsed = parse_source("npm:@foo/bar@1.2.3")
    assert isinstance(parsed, NpmSource)
    assert parsed.type == "npm"
    assert parsed.spec == "@foo/bar@1.2.3"
    assert parsed.name == "@foo/bar"
    assert parsed.pinned is True

    unpinned = parse_source("npm:lodash")
    assert isinstance(unpinned, NpmSource)
    assert unpinned.name == "lodash"
    assert unpinned.pinned is False


def test_parse_npm_spec():
    assert parse_npm_spec("@scope/pkg@1.0.0") == ("@scope/pkg", "1.0.0")
    assert parse_npm_spec("lodash") == ("lodash", None)
    assert parse_npm_spec("pkg@latest") == ("pkg", "latest")


def test_parse_source_git():
    parsed = parse_source("https://github.com/org/repo")
    assert isinstance(parsed, GitSource)
    assert parsed.type == "git"
    assert parsed.host == "github.com"
    assert parsed.path == "org/repo"
    assert parsed.repo == "https://github.com/org/repo"

    shorthand = parse_source("git:github.com/org/repo")
    assert isinstance(shorthand, GitSource)
    assert shorthand.host == "github.com"
    assert shorthand.path == "org/repo"

    with_ref = parse_source("git:https://github.com/org/repo@v1.0.0")
    assert isinstance(with_ref, GitSource)
    assert with_ref.ref == "v1.0.0"
    assert with_ref.pinned is True


@pytest.mark.anyio
async def test_install_and_remove_local_package_user_scope(package_env, tmp_path):
    source_dir = tmp_path / "my-ext"
    source_dir.mkdir()
    (source_dir / "index.py").write_text("print('ok')\n", encoding="utf-8")

    manager = SettingsManager.create(package_env["project_dir"], package_env["agent_dir"])
    package_manager = DefaultPackageManager(
        cwd=package_env["project_dir"],
        agent_dir=package_env["agent_dir"],
        settings_manager=manager,
    )

    await package_manager.install_and_persist(str(source_dir))
    configured = package_manager.list_configured_packages()
    assert len(configured) == 1
    assert configured[0]["scope"] == "user"
    assert configured[0]["installedPath"] is not None
    assert os.path.exists(configured[0]["installedPath"])

    with open(package_env["global_settings_path"], encoding="utf-8") as handle:
        saved = json.load(handle)
    assert saved.get("packages")

    removed = await package_manager.remove_and_persist(str(source_dir))
    assert removed is True
    assert package_manager.list_configured_packages() == []


@pytest.mark.anyio
async def test_install_local_package_project_scope(package_env, tmp_path):
    source_dir = tmp_path / "project-ext"
    source_dir.mkdir()

    manager = SettingsManager.create(package_env["project_dir"], package_env["agent_dir"])
    package_manager = DefaultPackageManager(
        cwd=package_env["project_dir"],
        agent_dir=package_env["agent_dir"],
        settings_manager=manager,
    )

    await package_manager.install_and_persist(str(source_dir), local=True)
    configured = package_manager.list_configured_packages()
    assert len(configured) == 1
    assert configured[0]["scope"] == "project"

    with open(package_env["project_settings_path"], encoding="utf-8") as handle:
        saved = json.load(handle)
    assert saved.get("packages")


@pytest.mark.anyio
async def test_resolve_discovers_top_level_extension(package_env, tmp_path):
    extension_file = tmp_path / "demo.py"
    extension_file.write_text("def default(api):\n    pass\n", encoding="utf-8")
    manager = SettingsManager.create(package_env["project_dir"], package_env["agent_dir"])
    manager.set_project_extension_paths([str(extension_file)])
    package_manager = DefaultPackageManager(
        cwd=package_env["project_dir"],
        agent_dir=package_env["agent_dir"],
        settings_manager=manager,
    )
    resolved = await package_manager.resolve()
    assert len(resolved["extensions"]) == 1
    assert os.path.abspath(resolved["extensions"][0]["path"]) == os.path.abspath(
        str(extension_file)
    )
    assert resolved["extensions"][0]["enabled"] is True


@pytest.mark.anyio
async def test_resolve_returns_empty(package_env):
    manager = SettingsManager.create(package_env["project_dir"], package_env["agent_dir"])
    package_manager = DefaultPackageManager(
        cwd=package_env["project_dir"],
        agent_dir=package_env["agent_dir"],
        settings_manager=manager,
    )
    resolved = await package_manager.resolve()
    assert resolved == {
        "extensions": [],
        "skills": [],
        "prompts": [],
        "themes": [],
    }


def _mock_subprocess(returncode: int = 0, stdout: bytes = b"", stderr: bytes = b""):
    process = MagicMock()
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=(stdout, stderr))
    process.wait = AsyncMock(return_value=returncode)
    process.kill = MagicMock()
    return process


@pytest.mark.anyio
async def test_install_npm_mocked_subprocess(package_env):
    manager = SettingsManager.create(package_env["project_dir"], package_env["agent_dir"])
    package_manager = DefaultPackageManager(
        cwd=package_env["project_dir"],
        agent_dir=package_env["agent_dir"],
        settings_manager=manager,
    )

    npm_root = os.path.join(package_env["agent_dir"], "npm")
    installed_path = os.path.join(npm_root, "node_modules", "lodash")
    os.makedirs(installed_path, exist_ok=True)

    calls: list[tuple[str, tuple[str, ...]]] = []

    async def fake_create_subprocess_exec(command, *args, **kwargs):
        calls.append((command, args))
        return _mock_subprocess()

    with patch("asyncio.create_subprocess_exec", side_effect=fake_create_subprocess_exec):
        await package_manager.install_and_persist("npm:lodash")

    assert calls
    assert calls[0][0] == "npm"
    install_args = calls[0][1]
    assert "install" in install_args
    assert "lodash" in install_args
    assert "--prefix" in install_args
    assert npm_root in install_args

    configured = package_manager.list_configured_packages()
    assert len(configured) == 1
    assert configured[0]["source"] == "npm:lodash"


@pytest.mark.anyio
async def test_install_git_mocked_subprocess(package_env):
    manager = SettingsManager.create(package_env["project_dir"], package_env["agent_dir"])
    package_manager = DefaultPackageManager(
        cwd=package_env["project_dir"],
        agent_dir=package_env["agent_dir"],
        settings_manager=manager,
    )

    git_target = os.path.join(package_env["agent_dir"], "git", "github.com", "org", "repo")

    git_source = "https://github.com/org/repo"

    calls: list[tuple[str, tuple[str, ...]]] = []

    async def fake_create_subprocess_exec(command, *args, **kwargs):
        calls.append((command, args))
        if command == "git" and args[0] == "clone":
            os.makedirs(git_target, exist_ok=True)
        return _mock_subprocess()

    with patch("asyncio.create_subprocess_exec", side_effect=fake_create_subprocess_exec):
        await package_manager.install_and_persist(git_source)

    git_calls = [call for call in calls if call[0] == "git"]
    assert git_calls
    assert git_calls[0][1][0] == "clone"
    assert git_calls[0][1][1] == "https://github.com/org/repo"
    assert git_calls[0][1][2] == git_target

    configured = package_manager.list_configured_packages()
    assert len(configured) == 1
    assert configured[0]["source"] == git_source
    assert package_manager.get_installed_path(git_source, "user") == git_target


@pytest.mark.anyio
async def test_remove_git_mocked(package_env):
    manager = SettingsManager.create(package_env["project_dir"], package_env["agent_dir"])
    package_manager = DefaultPackageManager(
        cwd=package_env["project_dir"],
        agent_dir=package_env["agent_dir"],
        settings_manager=manager,
    )

    git_source = "https://github.com/org/repo"
    git_target = os.path.join(package_env["agent_dir"], "git", "github.com", "org", "repo")
    os.makedirs(git_target, exist_ok=True)
    manager.set_packages([git_source])
    await manager.flush()

    removed = await package_manager.remove_and_persist(git_source)
    assert removed is True
    assert not os.path.exists(git_target)
    assert package_manager.list_configured_packages() == []
