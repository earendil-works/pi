"""HTML export from session files using the shared template bundle."""

from __future__ import annotations

import base64
import html
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pi_mono.config import APP_NAME, get_export_template_dir
from pi_mono.core.session_manager import SessionManager
from pi_mono.coding_agent.core.export_html.tool_renderer import ToolHtmlRenderer
from pi_mono.utils.paths import normalize_path, resolve_path

TEMPLATE_RENDERED_TOOLS = frozenset({"bash", "read", "write", "edit", "ls"})


@dataclass
class ExportOptions:
    output_path: str | None = None
    theme_name: str | None = None
    tool_renderer: ToolHtmlRenderer | None = None


@dataclass
class RenderedToolHtml:
    call_html: str | None = None
    result_html_collapsed: str | None = None
    result_html_expanded: str | None = None


def _escape(text: str) -> str:
    return html.escape(text, quote=True)


def _message_text(message: dict[str, Any]) -> str:
    parts: list[str] = []
    for block in message.get("content", []):
        if block.get("type") == "text" and block.get("text"):
            parts.append(str(block["text"]))
        elif block.get("type") == "thinking" and block.get("thinking"):
            parts.append(f"[thinking] {block['thinking']}")
    return "\n".join(parts)


def _render_message_html(message: dict[str, Any]) -> str:
    role = message.get("role", "unknown")
    text = _message_text(message)
    css_class = {
        "user": "user-message",
        "assistant": "assistant-message",
        "toolResult": "tool-message",
    }.get(role, "message")
    title = role
    if role == "toolResult":
        title = f"tool: {message.get('toolName', 'unknown')}"
    return (
        f'<section class="{css_class}">'
        f"<h3>{_escape(title)}</h3>"
        f"<pre>{_escape(text)}</pre>"
        f"</section>"
    )


def _generate_theme_vars(theme_name: str | None = None) -> str:
    from pi_mono.coding_agent.modes.interactive.theme.theme import THEMES_DIR

    name = theme_name or "dark"
    theme_path = THEMES_DIR / f"{name}.json"
    if not theme_path.exists():
        theme_path = THEMES_DIR / "dark.json"
    with theme_path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    vars_map = data.get("vars", {})
    colors = data.get("colors", {})
    lines: list[str] = []
    for key, ref in colors.items():
        value = vars_map.get(ref, ref) if isinstance(ref, str) else ref
        if isinstance(value, str):
            lines.append(f"--{key}: {value};")
    lines.append("--exportPageBg: rgb(24, 24, 30);")
    lines.append("--exportCardBg: rgb(30, 30, 36);")
    lines.append("--exportInfoBg: rgb(60, 55, 40);")
    return "\n      ".join(lines)


def _template_assets_available() -> bool:
    template_dir = get_export_template_dir()
    return (template_dir / "template.html").exists()


def _generate_template_html(session_data: dict[str, Any], theme_name: str | None = None) -> str:
    template_dir = get_export_template_dir()
    template = (template_dir / "template.html").read_text(encoding="utf-8")
    template_css = (template_dir / "template.css").read_text(encoding="utf-8")
    template_js = (template_dir / "template.js").read_text(encoding="utf-8")
    marked_js = (template_dir / "vendor" / "marked.min.js").read_text(encoding="utf-8")
    hljs_js = (template_dir / "vendor" / "highlight.min.js").read_text(encoding="utf-8")

    theme_vars = _generate_theme_vars(theme_name)
    session_data_base64 = base64.b64encode(json.dumps(session_data).encode("utf-8")).decode("ascii")

    css = (
        template_css.replace("{{THEME_VARS}}", theme_vars)
        .replace("{{BODY_BG}}", "rgb(24, 24, 30)")
        .replace("{{CONTAINER_BG}}", "rgb(30, 30, 36)")
        .replace("{{INFO_BG}}", "rgb(60, 55, 40)")
    )

    return (
        template.replace("{{CSS}}", css)
        .replace("{{JS}}", template_js)
        .replace("{{SESSION_DATA}}", session_data_base64)
        .replace("{{MARKED_JS}}", marked_js)
        .replace("{{HIGHLIGHT_JS}}", hljs_js)
    )


def _generate_minimal_html(session_data: dict[str, Any]) -> str:
    header = session_data.get("header") or {}
    entries = session_data.get("entries") or []
    title = header.get("id") or "Session"
    cwd = header.get("cwd") or ""

    message_sections: list[str] = []
    for entry in entries:
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if message:
            message_sections.append(_render_message_html(message))

    body = "\n".join(message_sections) if message_sections else "<p>(no messages)</p>"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{_escape(str(title))}</title>
  <style>
    body {{ font-family: system-ui, sans-serif; margin: 2rem; background: #1e1e24; color: #d4d4d4; }}
    .user-message pre {{ background: #343541; padding: 1rem; border-radius: 8px; white-space: pre-wrap; }}
    .assistant-message pre {{ background: #2a2a32; padding: 1rem; border-radius: 8px; white-space: pre-wrap; }}
    .tool-message pre {{ background: #283228; padding: 1rem; border-radius: 8px; white-space: pre-wrap; }}
    h1, h3 {{ color: #8abeb7; }}
    .meta {{ color: #808080; margin-bottom: 2rem; }}
  </style>
</head>
<body>
  <h1>{_escape(APP_NAME)} session export</h1>
  <p class="meta">cwd: {_escape(str(cwd))}</p>
  {body}
</body>
</html>
"""


def _build_session_data_from_manager(session_manager: SessionManager) -> dict[str, Any]:
    return {
        "header": session_manager.get_header(),
        "entries": session_manager.get_entries(),
        "leafId": session_manager.get_leaf_id(),
    }


def _serialize_rendered_tools(
    rendered_tools: dict[str, RenderedToolHtml],
) -> dict[str, dict[str, str | None]]:
    payload: dict[str, dict[str, str | None]] = {}
    for tool_call_id, rendered in rendered_tools.items():
        entry: dict[str, str | None] = {}
        if rendered.call_html:
            entry["callHtml"] = rendered.call_html
        if rendered.result_html_collapsed:
            entry["resultHtmlCollapsed"] = rendered.result_html_collapsed
        if rendered.result_html_expanded:
            entry["resultHtmlExpanded"] = rendered.result_html_expanded
        if entry:
            payload[tool_call_id] = entry
    return payload


def pre_render_tools(
    entries: list[dict[str, Any]],
    tool_renderer: ToolHtmlRenderer,
) -> dict[str, RenderedToolHtml]:
    rendered_tools: dict[str, RenderedToolHtml] = {}

    for entry in entries:
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        role = message.get("role")

        if role == "assistant":
            for block in message.get("content", []):
                if block.get("type") != "toolCall":
                    continue
                tool_name = str(block.get("name", ""))
                if tool_name in TEMPLATE_RENDERED_TOOLS:
                    continue
                call_html = tool_renderer.render_call(
                    str(block.get("id", "")),
                    tool_name,
                    block.get("arguments", {}),
                )
                if call_html:
                    tool_call_id = str(block.get("id", ""))
                    rendered_tools.setdefault(tool_call_id, RenderedToolHtml()).call_html = (
                        call_html
                    )

        if role == "toolResult":
            tool_call_id = str(message.get("toolCallId", ""))
            if not tool_call_id:
                continue
            tool_name = str(message.get("toolName", ""))
            existing = rendered_tools.get(tool_call_id)
            if not existing and tool_name in TEMPLATE_RENDERED_TOOLS:
                continue
            rendered = tool_renderer.render_result(
                tool_call_id,
                tool_name,
                list(message.get("content", [])),
                message.get("details"),
                bool(message.get("isError")),
            )
            if rendered:
                current = rendered_tools.setdefault(tool_call_id, RenderedToolHtml())
                if rendered.get("collapsed"):
                    current.result_html_collapsed = rendered["collapsed"]
                if rendered.get("expanded"):
                    current.result_html_expanded = rendered["expanded"]

    return rendered_tools


def generate_html(session_data: dict[str, Any], theme_name: str | None = None) -> str:
    if _template_assets_available():
        return _generate_template_html(session_data, theme_name)
    return _generate_minimal_html(session_data)


def _resolve_export_options(
    output_path: str | None = None,
    *,
    theme_name: str | None = None,
    tool_renderer: ToolHtmlRenderer | None = None,
    options: ExportOptions | str | None = None,
) -> ExportOptions:
    if isinstance(options, str):
        return ExportOptions(
            output_path=options, theme_name=theme_name, tool_renderer=tool_renderer
        )
    if options is not None:
        return options
    return ExportOptions(
        output_path=output_path,
        theme_name=theme_name,
        tool_renderer=tool_renderer,
    )


def _attach_rendered_tools(
    session_data: dict[str, Any],
    tool_renderer: ToolHtmlRenderer | None,
) -> None:
    if tool_renderer is None:
        return
    rendered = pre_render_tools(session_data.get("entries", []), tool_renderer)
    serialized = _serialize_rendered_tools(rendered)
    if serialized:
        session_data["renderedTools"] = serialized


def export_session_to_html(
    session: Any,
    output_path: str | None = None,
    *,
    theme_name: str | None = None,
    tool_renderer: ToolHtmlRenderer | None = None,
    options: ExportOptions | None = None,
) -> str:
    opts = _resolve_export_options(
        output_path,
        theme_name=theme_name,
        tool_renderer=tool_renderer,
        options=options,
    )
    session_manager = session.session_manager
    session_file = session_manager.get_session_file()
    if session_file and not Path(session_file).exists():
        raise FileNotFoundError("Nothing to export yet - start a conversation first")

    session_data = _build_session_data_from_manager(session_manager)
    session_data["systemPrompt"] = getattr(session, "system_prompt", None)
    session_data["tools"] = [
        {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }
        for tool in session.agent.state.tools
    ]
    _attach_rendered_tools(session_data, opts.tool_renderer)
    html_content = generate_html(session_data, opts.theme_name)

    if opts.output_path:
        resolved_output = normalize_path(opts.output_path)
    else:
        session_id = getattr(session, "session_id", None) or "session"
        if session_file:
            resolved_output = f"{APP_NAME}-session-{Path(session_file).stem}.html"
        else:
            resolved_output = f"{APP_NAME}-session-{session_id}.html"

    Path(resolved_output).write_text(html_content, encoding="utf-8")
    return resolved_output


def export_from_file(
    session_path: str,
    output_path: str | None = None,
    *,
    theme_name: str | None = None,
    tool_renderer: ToolHtmlRenderer | None = None,
    options: ExportOptions | None = None,
) -> str:
    """Export a JSONL session file to HTML."""
    opts = _resolve_export_options(
        output_path,
        theme_name=theme_name,
        tool_renderer=tool_renderer,
        options=options,
    )
    resolved_input = resolve_path(session_path)
    input_file = Path(resolved_input)
    if not input_file.exists():
        raise FileNotFoundError(f"File not found: {resolved_input}")

    session_manager = SessionManager.open(resolved_input)
    session_data = _build_session_data_from_manager(session_manager)
    _attach_rendered_tools(session_data, opts.tool_renderer)
    html_content = generate_html(session_data, opts.theme_name)

    if opts.output_path:
        resolved_output = normalize_path(opts.output_path)
    else:
        resolved_output = f"{APP_NAME}-session-{input_file.stem}.html"

    Path(resolved_output).write_text(html_content, encoding="utf-8")
    return resolved_output
