"""System prompt construction and project context loading."""

from __future__ import annotations

from datetime import datetime

from pi_mono.agent.harness.system_prompt import format_skills_for_system_prompt
from pi_mono.agent.harness.types import Skill
from pi_mono.config import get_docs_path, get_examples_path, get_readme_path


def build_system_prompt(
    *,
    custom_prompt: str | None = None,
    selected_tools: list[str] | None = None,
    tool_snippets: dict[str, str] | None = None,
    prompt_guidelines: list[str] | None = None,
    append_system_prompt: str | None = None,
    cwd: str,
    context_files: list[dict[str, str]] | None = None,
    skills: list[Skill] | None = None,
) -> str:
    prompt_cwd = cwd.replace("\\", "/")
    now = datetime.now()
    date = now.strftime("%Y-%m-%d")
    append_section = f"\n\n{append_system_prompt}" if append_system_prompt else ""
    resolved_context_files = context_files or []
    resolved_skills = skills or []

    if custom_prompt:
        prompt = custom_prompt
        if append_section:
            prompt += append_section
        if resolved_context_files:
            prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n"
            for file_entry in resolved_context_files:
                prompt += (
                    f'<project_instructions path="{file_entry["path"]}">\n'
                    f"{file_entry['content']}\n</project_instructions>\n\n"
                )
            prompt += "</project_context>\n"
        custom_prompt_has_read = not selected_tools or "read" in selected_tools
        if custom_prompt_has_read and resolved_skills:
            prompt += format_skills_for_system_prompt(resolved_skills)
        prompt += f"\nCurrent date: {date}"
        prompt += f"\nCurrent working directory: {prompt_cwd}"
        return prompt

    readme_path = get_readme_path()
    docs_path = get_docs_path()
    examples_path = get_examples_path()

    tools = selected_tools or ["read", "bash", "edit", "write"]
    visible_tools = [name for name in tools if tool_snippets and tool_snippets.get(name)]
    if visible_tools:
        tools_list = "\n".join(f"- {name}: {tool_snippets[name]}" for name in visible_tools)
    else:
        tools_list = "(none)"

    guidelines_list: list[str] = []
    guidelines_set: set[str] = set()

    def add_guideline(guideline: str) -> None:
        if guideline in guidelines_set:
            return
        guidelines_set.add(guideline)
        guidelines_list.append(guideline)

    has_bash = "bash" in tools
    has_grep = "grep" in tools
    has_find = "find" in tools
    has_ls = "ls" in tools
    has_read = "read" in tools

    if has_bash and not has_grep and not has_find and not has_ls:
        add_guideline("Use bash for file operations like ls, rg, find")

    for guideline in prompt_guidelines or []:
        normalized = guideline.strip()
        if normalized:
            add_guideline(normalized)

    add_guideline("Be concise in your responses")
    add_guideline("Show file paths clearly when working with files")

    guidelines = "\n".join(f"- {item}" for item in guidelines_list)

    prompt = f"""You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
{tools_list}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
{guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: {readme_path}
- Additional docs: {docs_path}
- Examples: {examples_path} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)"""

    if append_section:
        prompt += append_section

    if resolved_context_files:
        prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n"
        for file_entry in resolved_context_files:
            prompt += (
                f'<project_instructions path="{file_entry["path"]}">\n'
                f"{file_entry['content']}\n</project_instructions>\n\n"
            )
        prompt += "</project_context>\n"

    if has_read and resolved_skills:
        prompt += format_skills_for_system_prompt(resolved_skills)

    prompt += f"\nCurrent date: {date}"
    prompt += f"\nCurrent working directory: {prompt_cwd}"
    return prompt
