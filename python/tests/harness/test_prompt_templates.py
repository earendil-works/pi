import os
import pytest
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.prompt_templates import (
    loadPromptTemplates,
    loadSourcedPromptTemplates,
    formatPromptTemplateInvocation,
)
from pi_mono.agent.harness.types import PromptTemplate
from tests.harness.session_test_utils import createTempDir, cleanupTempDirs


@pytest.fixture(autouse=True)
def run_around_tests():
    yield
    cleanupTempDirs()


@pytest.mark.anyio
async def test_loads_markdown_templates_non_recursively_from_one_or_more_dirs():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.createDir("a/nested", {"recursive": True})
    await env.createDir("b", {"recursive": True})
    await env.writeFile("a/one.md", "---\ndescription: One template\n---\nHello $1")
    await env.writeFile("a/nested/ignored.md", "Ignored")
    await env.writeFile("b/two.md", "First line description\nBody")

    result = await loadPromptTemplates(env, ["a", "b"])
    prompt_templates = result["prompt_templates"]
    diagnostics = result["diagnostics"]

    assert diagnostics == []
    assert prompt_templates == [
        PromptTemplate(name="one", description="One template", content="Hello $1"),
        PromptTemplate(
            name="two", description="First line description", content="First line description\nBody"
        ),
    ]


@pytest.mark.anyio
async def test_preserves_source_info_for_sourced_prompt_templates():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.createDir("prompts", {"recursive": True})
    await env.writeFile("prompts/example.md", "---\ndescription: Example\n---\nExample body")

    result = await loadSourcedPromptTemplates(
        env, [{"path": "prompts", "source": {"type": "project"}}]
    )
    prompt_templates = result["prompt_templates"]
    diagnostics = result["diagnostics"]

    assert diagnostics == []
    assert prompt_templates == [
        {
            "prompt_template": PromptTemplate(
                name="example", description="Example", content="Example body"
            ),
            "source": {"type": "project"},
        }
    ]


@pytest.mark.anyio
async def test_attaches_source_info_to_diagnostics():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.writeFile("broken.md", "---\ndescription: [unterminated\n---\nBody")

    result = await loadSourcedPromptTemplates(
        env, [{"path": "broken.md", "source": {"type": "user"}}]
    )
    prompt_templates = result["prompt_templates"]
    diagnostics = result["diagnostics"]

    assert prompt_templates == []
    assert len(diagnostics) == 1
    assert diagnostics[0]["type"] == "warning"
    assert diagnostics[0]["path"] == os.path.join(root, "broken.md")
    assert diagnostics[0]["source"] == {"type": "user"}


@pytest.mark.anyio
async def test_loads_explicit_markdown_files_and_symlinked_files():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    await env.writeFile("target.md", "---\ndescription: Target\n---\nTarget body")
    os.symlink(os.path.join(root, "target.md"), os.path.join(root, "link.md"))

    result = await loadPromptTemplates(env, ["target.md", "link.md"])
    prompt_templates = result["prompt_templates"]

    assert prompt_templates == [
        PromptTemplate(name="target", description="Target", content="Target body"),
        PromptTemplate(name="link", description="Target", content="Target body"),
    ]


def test_format_prompt_template_invocation():
    content = "$1 $" + "{@:2} $ARGUMENTS"
    template = PromptTemplate(name="one", content=content)
    assert (
        formatPromptTemplateInvocation(template, ["hello world", "test"])
        == "hello world test hello world test"
    )
