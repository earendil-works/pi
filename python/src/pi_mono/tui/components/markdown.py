"""Markdown component for terminal rendering."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Protocol

from pi_mono.tui.terminal_image import is_image_line
from pi_mono.tui.utils import apply_background_to_line, visible_width, wrap_text_with_ansi


class Component(Protocol):
    def render(self, width: int) -> list[str]: ...


@dataclass
class DefaultTextStyle:
    color: Callable[[str], str] | None = None
    bg_color: Callable[[str], str] | None = None
    bold: bool = False
    italic: bool = False
    strikethrough: bool = False
    underline: bool = False


@dataclass
class MarkdownTheme:
    heading: Callable[[str], str]
    link: Callable[[str], str]
    link_url: Callable[[str], str]
    code: Callable[[str], str]
    code_block: Callable[[str], str]
    code_block_border: Callable[[str], str]
    quote: Callable[[str], str]
    quote_border: Callable[[str], str]
    hr: Callable[[str], str]
    list_bullet: Callable[[str], str]
    bold: Callable[[str], str]
    italic: Callable[[str], str]
    strikethrough: Callable[[str], str]
    underline: Callable[[str], str]
    code_block_indent: str = "  "


@dataclass
class MarkdownOptions:
    preserve_ordered_list_markers: bool = False


_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
_STRIKE_RE = re.compile(r"~~([^~]+)~~")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


class Markdown:
    def __init__(
        self,
        text: str,
        padding_x: int,
        padding_y: int,
        theme: MarkdownTheme,
        default_text_style: DefaultTextStyle | None = None,
        options: MarkdownOptions | None = None,
    ) -> None:
        self.text = text
        self.padding_x = padding_x
        self.padding_y = padding_y
        self.theme = theme
        self.default_text_style = default_text_style
        self.options = options or MarkdownOptions()
        self._cached_text: str | None = None
        self._cached_width: int | None = None
        self._cached_lines: list[str] | None = None

    def set_text(self, text: str) -> None:
        self.text = text
        self.invalidate()

    def invalidate(self) -> None:
        self._cached_text = None
        self._cached_width = None
        self._cached_lines = None

    def render(self, width: int) -> list[str]:
        if (
            self._cached_lines is not None
            and self._cached_text == self.text
            and self._cached_width == width
        ):
            return self._cached_lines

        content_width = max(1, width - self.padding_x * 2)
        if not self.text or not self.text.strip():
            self._cached_text = self.text
            self._cached_width = width
            self._cached_lines = []
            return []

        normalized_text = self.text.replace("\t", "   ")
        rendered_lines = self._render_markdown(normalized_text)

        wrapped_lines: list[str] = []
        for line in rendered_lines:
            if is_image_line(line):
                wrapped_lines.append(line)
            else:
                wrapped_lines.extend(wrap_text_with_ansi(line, content_width))

        left_margin = " " * self.padding_x
        right_margin = " " * self.padding_x
        bg_fn = self.default_text_style.bg_color if self.default_text_style else None
        content_lines: list[str] = []
        for line in wrapped_lines:
            if is_image_line(line):
                content_lines.append(line)
                continue
            line_with_margins = left_margin + line + right_margin
            if bg_fn:
                content_lines.append(apply_background_to_line(line_with_margins, width, bg_fn))
            else:
                visible_len = visible_width(line_with_margins)
                padding_needed = max(0, width - visible_len)
                content_lines.append(line_with_margins + (" " * padding_needed))

        empty_line = " " * width
        result = [empty_line] * self.padding_y + content_lines + [empty_line] * self.padding_y
        self._cached_text = self.text
        self._cached_width = width
        self._cached_lines = result
        return result

    def _render_markdown(self, text: str) -> list[str]:
        lines: list[str] = []
        in_code_block = False
        code_block_lines: list[str] = []

        for raw_line in text.splitlines():
            if raw_line.strip().startswith("```"):
                if in_code_block:
                    border = self.theme.code_block_border("│")
                    indent = self.theme.code_block_indent
                    for code_line in code_block_lines:
                        lines.append(f"{border}{indent}{self.theme.code_block(code_line)}")
                    code_block_lines = []
                    in_code_block = False
                else:
                    in_code_block = True
                continue

            if in_code_block:
                code_block_lines.append(raw_line)
                continue

            stripped = raw_line.strip()
            if not stripped:
                lines.append("")
                continue
            if stripped.startswith("#"):
                level = len(stripped) - len(stripped.lstrip("#"))
                content = stripped[level:].strip()
                lines.append(self.theme.heading(self._apply_inline(content)))
                continue
            if stripped.startswith(">"):
                content = stripped[1:].strip()
                lines.append(
                    f"{self.theme.quote_border('│')} {self.theme.quote(self._apply_inline(content))}"
                )
                continue
            if stripped in ("---", "***", "___"):
                lines.append(self.theme.hr("─" * 40))
                continue
            bullet_match = re.match(r"^([-*+]|\d+\.)\s+(.*)$", stripped)
            if bullet_match:
                marker, content = bullet_match.groups()
                lines.append(f"{self.theme.list_bullet(marker)} {self._apply_inline(content)}")
                continue
            lines.append(self._apply_inline(raw_line))

        if in_code_block and code_block_lines:
            border = self.theme.code_block_border("│")
            indent = self.theme.code_block_indent
            for code_line in code_block_lines:
                lines.append(f"{border}{indent}{self.theme.code_block(code_line)}")
        return lines

    def _apply_inline(self, text: str) -> str:
        result = text
        result = _INLINE_CODE_RE.sub(lambda match: self.theme.code(match.group(1)), result)
        result = _BOLD_RE.sub(lambda match: self.theme.bold(match.group(1)), result)
        result = _ITALIC_RE.sub(lambda match: self.theme.italic(match.group(1)), result)
        result = _STRIKE_RE.sub(lambda match: self.theme.strikethrough(match.group(1)), result)
        result = _LINK_RE.sub(
            lambda match: f"{self.theme.link(match.group(1))} ({self.theme.link_url(match.group(2))})",
            result,
        )
        if self.default_text_style and self.default_text_style.color:
            result = self.default_text_style.color(result)
        return result
