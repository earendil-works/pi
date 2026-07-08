"""Prompt template loading utilities for agent harness."""

from __future__ import annotations

from typing import Any, TypeVar

from pi_mono.agent.harness.types import (
    ExecutionEnv,
    PromptTemplate,
    PromptTemplateDiagnostic,
    FileInfo,
)

TSource = TypeVar("TSource")
TPromptTemplate = TypeVar("TPromptTemplate", bound="PromptTemplate")


async def load_prompt_templates(
    env: ExecutionEnv,
    paths: str | list[str],
) -> dict[str, list[Any]]:
    """Load prompt templates from one or more paths."""
    prompt_templates: list[PromptTemplate] = []
    diagnostics: list[PromptTemplateDiagnostic] = []

    for path in [paths] if isinstance(paths, str) else paths:
        info_result = await env.file_info(path)
        if not info_result.ok:
            if info_result.error.code != "not_found":
                diagnostics.append(
                    PromptTemplateDiagnostic(
                        type="warning",
                        code="file_info_failed",
                        message=info_result.error.message,
                        path=path,
                    )
                )
            continue

        info = info_result.value
        kind = await _resolve_kind(env, info, diagnostics)
        if kind == "directory":
            result = await _load_templates_from_dir(env, info.path)
            prompt_templates.extend(result[0])
            diagnostics.extend(result[1])
        elif kind == "file" and info.name.endswith(".md"):
            result = await _load_template_from_file(env, info.path)
            if result[0]:
                prompt_templates.append(result[0])
            diagnostics.extend(result[1])

    return {"prompt_templates": prompt_templates, "diagnostics": diagnostics}


async def load_sourced_prompt_templates(
    env: ExecutionEnv,
    inputs: list[dict[str, Any]],
    map_prompt_template: Any = None,
) -> dict[str, list[Any]]:
    """Load prompt templates from source-tagged paths."""
    prompt_templates: list[dict] = []
    diagnostics: list[dict] = []

    for input_item in inputs:
        result = await load_prompt_templates(env, input_item["path"])
        for template in result["prompt_templates"]:
            prompt_templates.append(
                {
                    "prompt_template": (
                        map_prompt_template(template, input_item["source"])
                        if map_prompt_template
                        else template
                    ),
                    "source": input_item["source"],
                }
            )
        for diag in result["diagnostics"]:
            diagnostics.append(
                {
                    "type": diag.type,
                    "code": diag.code,
                    "message": diag.message,
                    "path": diag.path,
                    "source": input_item["source"],
                }
            )

    return {"prompt_templates": prompt_templates, "diagnostics": diagnostics}


async def _resolve_kind(
    env: ExecutionEnv,
    info: FileInfo,
    diagnostics: list[PromptTemplateDiagnostic],
) -> str | None:
    if info.kind in ("file", "directory"):
        return info.kind
    canonical = await env.canonical_path(info.path)
    if not canonical.ok:
        if canonical.error.code != "not_found":
            diagnostics.append(
                PromptTemplateDiagnostic(
                    type="warning",
                    code="file_info_failed",
                    message=canonical.error.message,
                    path=info.path,
                )
            )
        return None
    target = await env.file_info(canonical.value)
    if not target.ok:
        if target.error.code != "not_found":
            diagnostics.append(
                PromptTemplateDiagnostic(
                    type="warning",
                    code="file_info_failed",
                    message=target.error.message,
                    path=info.path,
                )
            )
        return None
    return target.value.kind if target.value.kind in ("file", "directory") else None


async def _load_templates_from_dir(
    env: ExecutionEnv,
    dir_path: str,
) -> tuple[list[PromptTemplate], list[PromptTemplateDiagnostic]]:
    prompt_templates = []
    diagnostics = []
    entries_result = await env.list_dir(dir_path)
    if not entries_result.ok:
        diagnostics.append(
            PromptTemplateDiagnostic(
                type="warning",
                code="list_failed",
                message=entries_result.error.message,
                path=dir_path,
            )
        )
        return [], diagnostics

    for entry in sorted(entries_result.value, key=lambda e: e.name):
        kind = await _resolve_kind(env, entry, diagnostics)
        if kind != "file" or not entry.name.endswith(".md"):
            continue
        result = await _load_template_from_file(env, entry.path)
        if result[0]:
            prompt_templates.append(result[0])
        diagnostics.extend(result[1])
    return prompt_templates, diagnostics


async def _load_template_from_file(
    env: ExecutionEnv,
    file_path: str,
) -> tuple[PromptTemplate | None, list[PromptTemplateDiagnostic]]:
    diagnostics: list[PromptTemplateDiagnostic] = []
    content_res = await env.read_text_file(file_path)
    if not content_res.ok:
        diagnostics.append(
            PromptTemplateDiagnostic(
                type="warning",
                code="read_failed",
                message=content_res.error.message,
                path=file_path,
            )
        )
        return None, diagnostics

    parsed = _parse_frontmatter(content_res.value)
    if parsed is None:
        diagnostics.append(
            PromptTemplateDiagnostic(
                type="warning",
                code="parse_failed",
                message="Failed to parse frontmatter",
                path=file_path,
            )
        )
        return None, diagnostics

    frontmatter, body = parsed
    first_line = None
    for line in body.split("\n"):
        if line.strip():
            first_line = line
            break

    description = frontmatter.get("description", "")
    if not description and first_line:
        description = first_line[:60]
        if len(first_line) > 60:
            description += "..."

    return (
        PromptTemplate(
            name=basename_env_path(file_path).replace(".md", ""),
            description=description or "",
            content=body,
        ),
        diagnostics,
    )


def _parse_frontmatter(content: str) -> tuple[dict, str] | None:
    try:
        normalized = content.replace("\r\n", "\n").replace("\r", "\n")
        if not normalized.startswith("---"):
            return {}, normalized
        end_index = normalized.find("\n---", 3)
        if end_index == -1:
            return {}, normalized
        yaml_string = normalized[4:end_index]
        body = normalized[end_index + 4 :].strip()
        import yaml

        frontmatter = yaml.safe_load(yaml_string) or {}
        return frontmatter, body
    except Exception:
        return None


def basename_env_path(path: str) -> str:
    normalized = path.rstrip("/")
    slash_index = normalized.rfind("/")
    return normalized if slash_index == -1 else normalized[slash_index + 1 :]


def parse_command_args(args_string: str) -> list[str]:
    """Parse an argument string using simple shell-style single and double quotes."""
    args = []
    current = ""
    in_quote: str | None = None

    for char in args_string:
        if current.startswith("\\") and len(current) > 1:
            current = current[1:]
        if in_quote:
            if char == in_quote:
                in_quote = None
            else:
                current += char
        elif char in ('"', "'"):
            in_quote = char
        elif char in (" ", "\t"):
            if current:
                current = current.rstrip()
                if current:
                    args.append(current)
                current = ""
        else:
            current += char

    if current:
        args.append(current.rstrip())
    return args


def substitute_args(content: str, args: list[str]) -> str:
    """Substitute prompt template placeholders with command arguments."""
    result = content
    import re

    result = re.sub(
        r"\$(\d+)",
        lambda m: args[int(m.group(1)) - 1] if int(m.group(1)) <= len(args) else "",
        result,
    )
    result = re.sub(
        r"\$\{@:(\d+)(?::(\d+))?\}",
        lambda m: (
            " ".join(args[int(m.group(1)) - 1 : int(m.group(1)) - 1 + int(m.group(2))])
            if m.group(2)
            else " ".join(args[int(m.group(1)) - 1 :])
        ),
        result,
    )
    all_args = " ".join(args)
    result = result.replace("$@", all_args).replace("$ARGUMENTS", all_args)
    return result


def expand_prompt_template(text: str, templates: list[PromptTemplate]) -> str:
    """Expand a /template invocation or return the original text."""
    if not text.startswith("/"):
        return text

    import re

    match = re.match(r"^/([^\s]+)(?:\s+([\s\S]*))?$", text)
    if not match:
        return text

    template_name = match.group(1)
    args_string = match.group(2) or ""
    template = next((item for item in templates if item.name == template_name), None)
    if template is None:
        return text

    return substitute_args(template.content, parse_command_args(args_string))


def format_prompt_template_invocation(template: PromptTemplate, args: list[str] = []) -> str:
    """Format a prompt template invocation with positional arguments."""
    return substitute_args(template.content, args)


# Add camelCase aliases for backward compatibility/TS parity
loadPromptTemplates = load_prompt_templates
loadSourcedPromptTemplates = load_sourced_prompt_templates
formatPromptTemplateInvocation = format_prompt_template_invocation
parseCommandArgs = parse_command_args
