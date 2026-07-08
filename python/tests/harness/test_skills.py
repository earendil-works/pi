import os
import pytest
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.skills import loadSkills, loadSourcedSkills
from pi_mono.agent.harness.types import Skill
from tests.harness.session_test_utils import createTempDir, cleanupTempDirs


@pytest.fixture(autouse=True)
def run_around_tests():
    yield
    cleanupTempDirs()


@pytest.mark.anyio
async def test_load_skills_md_files():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.createDir(".agents/skills/example", {"recursive": True})
    await env.writeFile(
        ".agents/skills/example/SKILL.md",
        "---\nname: example\ndescription: Example skill\ndisable-model-invocation: true\n---\nUse this skill.\n",
    )

    result = await loadSkills(env, ".agents/skills")
    skills = result["skills"]
    diagnostics = result["diagnostics"]

    assert diagnostics == []
    assert skills == [
        Skill(
            name="example",
            description="Example skill",
            content="Use this skill.",
            file_path=os.path.join(root, ".agents/skills/example/SKILL.md"),
            disable_model_invocation=True,
        )
    ]


@pytest.mark.anyio
async def test_load_skills_through_symlinks():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.createDir("actual/example", {"recursive": True})
    await env.writeFile(
        "actual/example/SKILL.md",
        "---\nname: example\ndescription: Example skill\n---\nUse this skill.",
    )
    os.symlink(os.path.join(root, "actual"), os.path.join(root, "skills-link"))

    result = await loadSkills(env, "skills-link")
    skills = result["skills"]

    assert [s.name for s in skills] == ["example"]
    assert skills[0].file_path == os.path.join(root, "skills-link/example/SKILL.md")


@pytest.mark.anyio
async def test_preserves_source_info_for_sourced_skills():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.createDir("user/example", {"recursive": True})
    await env.writeFile(
        "user/example/SKILL.md",
        "---\nname: example\ndescription: Example skill\n---\nUse this skill.",
    )

    result = await loadSourcedSkills(env, [{"path": "user", "source": {"type": "user"}}])
    skills = result["skills"]
    diagnostics = result["diagnostics"]

    assert diagnostics == []
    assert skills == [
        {
            "skill": Skill(
                name="example",
                description="Example skill",
                content="Use this skill.",
                file_path=os.path.join(root, "user/example/SKILL.md"),
                disable_model_invocation=False,
            ),
            "source": {"type": "user"},
        }
    ]


@pytest.mark.anyio
async def test_attaches_source_info_to_diagnostics():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.createDir("user/broken", {"recursive": True})
    await env.writeFile("user/broken/SKILL.md", "---\nname: broken\n---\nMissing description.")

    result = await loadSourcedSkills(env, [{"path": "user", "source": {"type": "user"}}])
    skills = result["skills"]
    diagnostics = result["diagnostics"]

    assert skills == []
    assert diagnostics == [
        {
            "type": "warning",
            "code": "invalid_metadata",
            "message": "description is required",
            "path": os.path.join(root, "user/broken/SKILL.md"),
            "source": {"type": "user"},
        }
    ]


@pytest.mark.anyio
async def test_loads_direct_markdown_children_only_from_root():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.createDir("skills/nested", {"recursive": True})
    await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content")
    await env.writeFile(
        "skills/nested/ignored.md", "---\ndescription: Ignored\n---\nIgnored content"
    )

    result = await loadSkills(env, "skills")
    skills = result["skills"]

    assert [s.name for s in skills] == ["skills"]
    assert skills[0].content == "Root content"
