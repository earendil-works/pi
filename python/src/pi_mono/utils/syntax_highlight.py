"""Syntax highlighting helpers (basic fallback without highlight.js)."""

from __future__ import annotations

import html
import re
from collections.abc import Callable
from typing import Any

HighlightFormatter = Callable[[str], str]
HighlightTheme = dict[str, HighlightFormatter]

_SPAN_CLOSE = "</span>"
_HIGHLIGHT_CLASS_PREFIX = "hljs-"
_SPAN_OPEN_RE = re.compile(r'\sclass\s*=\s*(?:"([^"]*)"|\'([^\']*)\')')


def _get_scope_from_span_tag(tag: str) -> str | None:
    match = _SPAN_OPEN_RE.search(tag)
    class_value = match.group(1) if match and match.group(1) is not None else None
    if match and class_value is None:
        class_value = match.group(2)
    if not class_value:
        return None
    for class_name in class_value.split():
        if class_name.startswith(_HIGHLIGHT_CLASS_PREFIX):
            return class_name[len(_HIGHLIGHT_CLASS_PREFIX) :]
    return None


def _get_scope_formatter(scope: str, theme: HighlightTheme) -> HighlightFormatter | None:
    exact = theme.get(scope)
    if exact:
        return exact
    dot_index = scope.find(".")
    if dot_index != -1:
        prefix_formatter = theme.get(scope[:dot_index])
        if prefix_formatter:
            return prefix_formatter
    dash_index = scope.find("-")
    if dash_index != -1:
        prefix_formatter = theme.get(scope[:dash_index])
        if prefix_formatter:
            return prefix_formatter
    return None


def _get_active_formatter(
    scopes: list[str | None], theme: HighlightTheme
) -> HighlightFormatter | None:
    for scope in reversed(scopes):
        if not scope:
            continue
        formatter = _get_scope_formatter(scope, theme)
        if formatter:
            return formatter
    return theme.get("default")


def _is_span_open_tag_start(source: str, index: int) -> bool:
    if not source.startswith("<span", index):
        return False
    if index + 5 >= len(source):
        return False
    next_char = source[index + 5]
    return next_char in (">", " ", "\t", "\n", "\r")


def render_highlighted_html(source: str, theme: HighlightTheme | None = None) -> str:
    """Apply theme formatters to highlight.js HTML span output."""
    active_theme = theme or {}
    output: list[str] = []
    text_buffer = ""
    scopes: list[str | None] = []

    def flush_text() -> None:
        nonlocal text_buffer
        if not text_buffer:
            return
        formatter = _get_active_formatter(scopes, active_theme)
        output.append(formatter(text_buffer) if formatter else text_buffer)
        text_buffer = ""

    index = 0
    while index < len(source):
        if _is_span_open_tag_start(source, index):
            tag_end_index = source.find(">", index + 5)
            if tag_end_index != -1:
                flush_text()
                tag = source[index : tag_end_index + 1]
                scopes.append(_get_scope_from_span_tag(tag))
                index = tag_end_index + 1
                continue

        if source.startswith(_SPAN_CLOSE, index):
            flush_text()
            if scopes:
                scopes.pop()
            index += len(_SPAN_CLOSE)
            continue

        if source[index] == "&":
            decoded = _decode_html_entity_at(source, index)
            if decoded:
                text_buffer += decoded[0]
                index += decoded[1]
                continue

        text_buffer += source[index]
        index += 1

    flush_text()
    return "".join(output)


def _decode_html_entity_at(source: str, index: int) -> tuple[str, int] | None:
    if not source.startswith("&", index):
        return None
    semicolon = source.find(";", index + 1)
    if semicolon == -1 or semicolon - index > 16:
        return None
    entity = source[index : semicolon + 1]
    if entity == "&lt;":
        return ("<", len(entity))
    if entity == "&gt;":
        return (">", len(entity))
    if entity == "&amp;":
        return ("&", len(entity))
    if entity == "&quot;":
        return ('"', len(entity))
    if entity == "&#39;":
        return ("'", len(entity))
    return None


def highlight(code: str, options: dict[str, Any] | None = None) -> str:
    """Return escaped code without real syntax highlighting (fallback)."""
    del options
    return html.escape(code)


def supports_language(name: str) -> bool:
    """No languages supported in the fallback highlighter."""
    del name
    return False
