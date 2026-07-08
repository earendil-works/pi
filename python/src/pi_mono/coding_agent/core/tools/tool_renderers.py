"""Built-in tool render helpers for the interactive TUI."""

from __future__ import annotations

import json
from typing import Any

from pi_mono.coding_agent.core.tools.render_utils import (
    get_text_output,
    normalize_display_text,
    render_tool_path,
    shorten_path,
)
from pi_mono.coding_agent.modes.interactive.components.diff import is_display_diff, render_diff
from pi_mono.coding_agent.modes.interactive.theme.theme import theme


def render_tool_call(tool_name: str, args: Any, cwd: str, *, expanded: bool) -> str:
    if not isinstance(args, dict):
        return theme.fg("toolTitle", theme.bold(tool_name))

    if tool_name == "read":
        path = render_tool_path(args.get("path"), cwd)
        offset = args.get("offset")
        limit = args.get("limit")
        suffix = ""
        if offset is not None or limit is not None:
            suffix = f" ({offset or 1}-{limit or 'end'})"
        return f"{theme.fg('toolTitle', theme.bold('read'))} {path}{suffix}"
    if tool_name == "bash":
        command = args.get("command")
        command_text = command if isinstance(command, str) else json.dumps(command)
        preview = command_text if expanded else command_text.splitlines()[0]
        return theme.fg("bashMode", theme.bold(f"$ {preview}"))
    if tool_name in ("edit", "write"):
        path = render_tool_path(args.get("path"), cwd)
        return f"{theme.fg('toolTitle', theme.bold(tool_name))} {path}"
    if tool_name == "grep":
        pattern = args.get("pattern")
        path = render_tool_path(args.get("path") or ".", cwd)
        return f"{theme.fg('toolTitle', theme.bold('grep'))} {theme.fg('toolOutput', str(pattern))} in {path}"
    if tool_name == "find":
        pattern = args.get("pattern") or args.get("glob")
        path = render_tool_path(args.get("path") or ".", cwd)
        return f"{theme.fg('toolTitle', theme.bold('find'))} {theme.fg('toolOutput', str(pattern))} in {path}"
    if tool_name == "ls":
        path = render_tool_path(args.get("path") or ".", cwd)
        return f"{theme.fg('toolTitle', theme.bold('ls'))} {path}"
    if expanded:
        return (
            f"{theme.fg('toolTitle', theme.bold(tool_name))}\n"
            f"{theme.fg('muted', json.dumps(args, indent=2))}"
        )
    return theme.fg("toolTitle", theme.bold(tool_name))


def render_tool_result(
    tool_name: str,
    args: Any,
    result: dict[str, Any] | None,
    cwd: str,
    *,
    expanded: bool,
    is_error: bool,
    show_images: bool = True,
) -> str:
    if is_error:
        return theme.fg("error", get_text_output(result, show_images=show_images))

    output = normalize_display_text(get_text_output(result, show_images=show_images))
    details = result.get("details") if isinstance(result, dict) else None
    if tool_name == "edit" and isinstance(details, dict) and isinstance(details.get("diff"), str):
        diff = details["diff"]
        if is_display_diff(diff):
            rendered = render_diff(diff)
            if expanded:
                return rendered
            lines = rendered.splitlines()
            preview = "\n".join(lines[:20])
            if len(lines) > 20:
                preview += theme.fg("muted", f"\n... ({len(lines) - 20} more lines)")
            return preview
        if expanded:
            return theme.fg("toolOutput", diff)
        lines = diff.splitlines()
        preview = "\n".join(lines[:20])
        if len(lines) > 20:
            preview += f"\n... ({len(lines) - 20} more lines)"
        return theme.fg("toolOutput", preview)

    if not output:
        if tool_name == "read" and isinstance(args, dict):
            return theme.fg("toolOutput", f"Read {shorten_path(str(args.get('path', '')))}")
        return theme.fg("muted", "(no output)")

    limit = 2000 if expanded else 500
    if len(output) > limit:
        output = output[: limit - 3] + "..."
    return theme.fg("toolOutput", output)
