"""Shared helpers for rendering tool call/result text in the TUI."""

from __future__ import annotations

import os
from typing import Any

from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.utils.ansi import strip_ansi
from pi_mono.utils.paths import resolve_path
from pi_mono.utils.shell import sanitize_binary_output


def shorten_path(path: Any) -> str:
    if not isinstance(path, str):
        return ""
    home = os.path.expanduser("~")
    if path.startswith(home):
        return f"~{path[len(home) :]}"
    return path


def str_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return None


def replace_tabs(text: str) -> str:
    return text.replace("\t", "   ")


def normalize_display_text(text: str) -> str:
    return text.replace("\r", "")


def get_text_output(
    result: dict[str, Any] | None,
    *,
    show_images: bool = True,
) -> str:
    if not result:
        return ""
    text_parts: list[str] = []
    image_blocks: list[dict[str, Any]] = []
    for block in result.get("content", []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and block.get("text"):
            text_parts.append(
                sanitize_binary_output(strip_ansi(str(block["text"]))).replace("\r", "")
            )
        elif block.get("type") == "image":
            image_blocks.append(block)

    output = "\n".join(text_parts)
    if image_blocks and not show_images:
        indicators = [
            f"[image: {block.get('mimeType') or 'image/unknown'}]" for block in image_blocks
        ]
        indicator_text = "\n".join(indicators)
        output = f"{output}\n{indicator_text}" if output else indicator_text
    return output


def invalid_arg_text() -> str:
    return theme.fg("error", "[invalid arg]")


def render_tool_path(
    raw_path: str | None,
    cwd: str,
    *,
    empty_fallback: str | None = None,
) -> str:
    if raw_path is None:
        return invalid_arg_text()
    value = raw_path or empty_fallback
    if not value:
        return theme.fg("toolOutput", "...")
    return theme.fg("accent", shorten_path(resolve_path(value, cwd)))
