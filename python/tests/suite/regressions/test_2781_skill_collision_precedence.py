"""Issue #2781: user/project skills override package skills with same name."""

from __future__ import annotations

import json
import os

import pytest

from pi_mono.coding_agent.core.resource_loader import DefaultResourceLoader, DefaultResourceLoaderOptions
from pi_mono.core.settings_manager import SettingsManager


def _create_package_with_skill(temp_dir: str, name: str, description: str) -> str:
    pkg_dir = os.path.join(temp_dir, f"fake-package-{name}")
    skill_dir = os.path.join(pkg_dir, "skills", name)
    os.makedirs(skill_dir, exist_ok=True)
    with open(os.path.join(pkg_dir, "package.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "name": f"fake-pkg-{name}",
                "version": "1.0.0",
                "pi": {"skills": [f"skills/{name}"]},
            },
            handle,
            indent=2,
        )
        handle.write("\n")
    with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as handle:
        handle.write(
            f"---\nname: {name}\ndescription: {description}\n---\nPackage skill content\n"
        )
    return pkg_dir


def _create_user_skill(agent_dir: str, name: str, description: str) -> str:
    skill_dir = os.path.join(agent_dir, "skills", name)
    os.makedirs(skill_dir, exist_ok=True)
    skill_path = os.path.join(skill_dir, "SKILL.md")
    with open(skill_path, "w", encoding="utf-8") as handle:
        handle.write(
            f"---\nname: {name}\ndescription: {description}\n---\nUser skill content\n"
        )
    return skill_path


def _create_project_skill(cwd: str, name: str, description: str) -> str:
    skill_dir = os.path.join(cwd, ".pi", "skills", name)
    os.makedirs(skill_dir, exist_ok=True)
    skill_path = os.path.join(skill_dir, "SKILL.md")
    with open(skill_path, "w", encoding="utf-8") as handle:
        handle.write(
            f"---\nname: {name}\ndescription: {description}\n---\nProject skill content\n"
        )
    return skill_path


def _create_settings_with_package(agent_dir: str, cwd: str, pkg_dir: str, scope: str) -> None:
    settings_dir = agent_dir if scope == "user" else os.path.join(cwd, ".pi")
    os.makedirs(settings_dir, exist_ok=True)
    with open(os.path.join(settings_dir, "settings.json"), "w", encoding="utf-8") as handle:
        json.dump({"packages": [pkg_dir]}, handle, indent=2)
        handle.write("\n")


@pytest.mark.anyio
async def test_user_skill_overrides_package_skill(tmp_path) -> None:
    agent_dir = str(tmp_path / "agent")
    cwd = str(tmp_path / "project")
    os.makedirs(agent_dir)
    os.makedirs(cwd)

    pkg_dir = _create_package_with_skill(str(tmp_path), "web-fetch", "Package web-fetch skill")
    user_skill_path = _create_user_skill(agent_dir, "web-fetch", "User web-fetch override")
    _create_settings_with_package(agent_dir, cwd, pkg_dir, "user")

    loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(cwd=cwd, agent_dir=agent_dir)
    )
    await loader.reload()

    skills = loader.get_skills()["skills"]
    web_fetch = next((skill for skill in skills if skill.name == "web-fetch"), None)
    assert web_fetch is not None
    assert web_fetch.file_path == user_skill_path
    assert web_fetch.description == "User web-fetch override"


@pytest.mark.anyio
async def test_project_skill_overrides_package_skill(tmp_path) -> None:
    agent_dir = str(tmp_path / "agent")
    cwd = str(tmp_path / "project")
    os.makedirs(agent_dir)
    os.makedirs(cwd)

    pkg_dir = _create_package_with_skill(str(tmp_path), "web-fetch", "Package web-fetch skill")
    project_skill_path = _create_project_skill(cwd, "web-fetch", "Project web-fetch override")
    _create_settings_with_package(agent_dir, cwd, pkg_dir, "user")

    loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(cwd=cwd, agent_dir=agent_dir)
    )
    await loader.reload()

    skills = loader.get_skills()["skills"]
    web_fetch = next((skill for skill in skills if skill.name == "web-fetch"), None)
    assert web_fetch is not None
    assert web_fetch.file_path == project_skill_path
    assert web_fetch.description == "Project web-fetch override"


@pytest.mark.anyio
async def test_project_skill_overrides_user_and_package_skills(tmp_path) -> None:
    agent_dir = str(tmp_path / "agent")
    cwd = str(tmp_path / "project")
    os.makedirs(agent_dir)
    os.makedirs(cwd)

    pkg_dir = _create_package_with_skill(str(tmp_path), "web-fetch", "Package web-fetch skill")
    _create_user_skill(agent_dir, "web-fetch", "User web-fetch override")
    project_skill_path = _create_project_skill(cwd, "web-fetch", "Project web-fetch override")
    _create_settings_with_package(agent_dir, cwd, pkg_dir, "user")

    loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(cwd=cwd, agent_dir=agent_dir)
    )
    await loader.reload()

    skills = loader.get_skills()["skills"]
    web_fetch = next((skill for skill in skills if skill.name == "web-fetch"), None)
    assert web_fetch is not None
    assert web_fetch.file_path == project_skill_path
    assert web_fetch.description == "Project web-fetch override"


@pytest.mark.anyio
async def test_collision_diagnostics_report_package_as_loser(tmp_path) -> None:
    agent_dir = str(tmp_path / "agent")
    cwd = str(tmp_path / "project")
    os.makedirs(agent_dir)
    os.makedirs(cwd)

    pkg_dir = _create_package_with_skill(str(tmp_path), "web-fetch", "Package web-fetch skill")
    _create_user_skill(agent_dir, "web-fetch", "User web-fetch override")
    _create_settings_with_package(agent_dir, cwd, pkg_dir, "user")

    loader = DefaultResourceLoader(
        DefaultResourceLoaderOptions(cwd=cwd, agent_dir=agent_dir)
    )
    await loader.reload()

    diagnostics = loader.get_skills()["diagnostics"]
    collision = next(
        (
            item
            for item in diagnostics
            if item.get("type") == "collision"
            and item.get("collision", {}).get("name") == "web-fetch"
        ),
        None,
    )
    assert collision is not None
    assert "fake-package" in collision["collision"]["loserPath"]
