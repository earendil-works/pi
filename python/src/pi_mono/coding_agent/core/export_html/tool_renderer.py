"""Tool HTML renderer for session export."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from pi_mono.coding_agent.core.export_html.ansi_to_html import ansi_lines_to_html
from pi_mono.coding_agent.core.tools.tool_renderers import render_tool_call, render_tool_result
from pi_mono.coding_agent.modes.interactive.theme.theme import Theme

BUILTIN_RENDER_TOOLS = frozenset({"read", "bash", "edit", "write", "grep", "find", "ls"})
ANSI_ESCAPE_REGEX = re.compile(r"\x1b\[[\d;]*m")


class ToolHtmlRenderer(Protocol):
    def render_call(self, tool_call_id: str, tool_name: str, args: Any) -> str | None: ...

    def render_result(
        self,
        tool_call_id: str,
        tool_name: str,
        result: list[dict[str, Any]],
        details: Any,
        is_error: bool,
    ) -> dict[str, str] | None: ...


@dataclass
class ToolHtmlRendererDeps:
    cwd: str
    get_tool_definition: Callable[[str], Any] | None = None
    theme: Theme | None = None
    width: int = 100


def _is_blank_rendered_line(line: str) -> bool:
    return ANSI_ESCAPE_REGEX.sub("", line).strip() == ""


def _trim_rendered_result_lines(lines: list[str]) -> list[str]:
    start = 0
    end = len(lines)
    while start < end and _is_blank_rendered_line(lines[start]):
        start += 1
    while end > start and _is_blank_rendered_line(lines[end - 1]):
        end -= 1
    return lines[start:end]


def _split_rendered_text(text: str, *, width: int) -> list[str]:
    del width
    return text.split("\n")


def create_tool_html_renderer(
    cwd: str,
    *,
    get_tool_definition: Callable[[str], Any] | None = None,
    theme: Theme | None = None,
    width: int = 100,
) -> ToolHtmlRenderer:
    options = ToolHtmlRendererDeps(
        cwd=cwd,
        get_tool_definition=get_tool_definition,
        theme=theme,
        width=width,
    )

    active_theme = options.theme or theme
    rendered_args: dict[str, Any] = {}

    class _Renderer:
        def render_call(self, tool_call_id: str, tool_name: str, args: Any) -> str | None:
            try:
                rendered_args[tool_call_id] = args
                if tool_name not in BUILTIN_RENDER_TOOLS:
                    tool_def = (
                        options.get_tool_definition(tool_name)
                        if options.get_tool_definition is not None
                        else None
                    )
                    render_call = getattr(tool_def, "render_call", None) if tool_def else None
                    if render_call is None:
                        return None
                    component = render_call(
                        args,
                        active_theme,
                        {
                            "args": args,
                            "toolCallId": tool_call_id,
                            "cwd": options.cwd,
                            "expanded": False,
                            "isPartial": True,
                            "isError": False,
                        },
                    )
                    lines = component.render(options.width)
                    return ansi_lines_to_html(lines)

                call_text = render_tool_call(tool_name, args, options.cwd, expanded=False)
                return ansi_lines_to_html(_split_rendered_text(call_text, width=options.width))
            except Exception:
                return None

        def render_result(
            self,
            tool_call_id: str,
            tool_name: str,
            result: list[dict[str, Any]],
            details: Any,
            is_error: bool,
        ) -> dict[str, str] | None:
            try:
                if tool_name not in BUILTIN_RENDER_TOOLS:
                    tool_def = (
                        options.get_tool_definition(tool_name)
                        if options.get_tool_definition is not None
                        else None
                    )
                    render_result_fn = (
                        getattr(tool_def, "render_result", None) if tool_def else None
                    )
                    if render_result_fn is None:
                        return None
                    agent_tool_result = {
                        "content": result,
                        "details": details,
                        "isError": is_error,
                    }
                    collapsed_component = render_result_fn(
                        agent_tool_result,
                        {"expanded": False, "isPartial": False},
                        active_theme,
                        {
                            "args": rendered_args.get(tool_call_id),
                            "toolCallId": tool_call_id,
                            "cwd": options.cwd,
                            "expanded": False,
                            "isPartial": False,
                            "isError": is_error,
                        },
                    )
                    expanded_component = render_result_fn(
                        agent_tool_result,
                        {"expanded": True, "isPartial": False},
                        active_theme,
                        {
                            "args": rendered_args.get(tool_call_id),
                            "toolCallId": tool_call_id,
                            "cwd": options.cwd,
                            "expanded": True,
                            "isPartial": False,
                            "isError": is_error,
                        },
                    )
                    collapsed = ansi_lines_to_html(
                        _trim_rendered_result_lines(collapsed_component.render(options.width))
                    )
                    expanded = ansi_lines_to_html(
                        _trim_rendered_result_lines(expanded_component.render(options.width))
                    )
                else:
                    args = rendered_args.get(tool_call_id, {})
                    result_payload = {
                        "content": result,
                        "details": details,
                    }
                    collapsed_text = render_tool_result(
                        tool_name,
                        args,
                        result_payload,
                        options.cwd,
                        expanded=False,
                        is_error=is_error,
                        show_images=False,
                    )
                    expanded_text = render_tool_result(
                        tool_name,
                        args,
                        result_payload,
                        options.cwd,
                        expanded=True,
                        is_error=is_error,
                        show_images=False,
                    )
                    collapsed = ansi_lines_to_html(
                        _trim_rendered_result_lines(
                            _split_rendered_text(collapsed_text, width=options.width)
                        )
                    )
                    expanded = ansi_lines_to_html(
                        _trim_rendered_result_lines(
                            _split_rendered_text(expanded_text, width=options.width)
                        )
                    )

                payload: dict[str, str] = {}
                if collapsed and collapsed != expanded:
                    payload["collapsed"] = collapsed
                if expanded:
                    payload["expanded"] = expanded
                return payload or None
            except Exception:
                return None

    return _Renderer()
