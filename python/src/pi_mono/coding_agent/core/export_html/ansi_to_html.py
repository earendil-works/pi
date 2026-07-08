"""ANSI escape code to HTML converter."""

from __future__ import annotations

import html
import re

ANSI_COLORS = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
]

ANSI_REGEX = re.compile(r"\x1b\[([\d;]*)m")


def _color256_to_hex(index: int) -> str:
    if index < 16:
        return ANSI_COLORS[index]
    if index < 232:
        cube_index = index - 16
        red = cube_index // 36
        green = (cube_index % 36) // 6
        blue = cube_index % 6

        def to_component(value: int) -> int:
            return 0 if value == 0 else 55 + value * 40

        def to_hex(value: int) -> str:
            return f"{to_component(value):02x}"

        return f"#{to_hex(red)}{to_hex(green)}{to_hex(blue)}"
    gray = 8 + (index - 232) * 10
    gray_hex = f"{gray:02x}"
    return f"#{gray_hex}{gray_hex}{gray_hex}"


def _escape_html(text: str) -> str:
    return html.escape(text, quote=True)


class _TextStyle:
    def __init__(self) -> None:
        self.fg: str | None = None
        self.bg: str | None = None
        self.bold = False
        self.dim = False
        self.italic = False
        self.underline = False

    def has_style(self) -> bool:
        return (
            self.fg is not None
            or self.bg is not None
            or self.bold
            or self.dim
            or self.italic
            or self.underline
        )

    def to_inline_css(self) -> str:
        parts: list[str] = []
        if self.fg:
            parts.append(f"color:{self.fg}")
        if self.bg:
            parts.append(f"background-color:{self.bg}")
        if self.bold:
            parts.append("font-weight:bold")
        if self.dim:
            parts.append("opacity:0.6")
        if self.italic:
            parts.append("font-style:italic")
        if self.underline:
            parts.append("text-decoration:underline")
        return ";".join(parts)


def _apply_sgr_code(params: list[int], style: _TextStyle) -> None:
    index = 0
    while index < len(params):
        code = params[index]
        if code == 0:
            style.fg = None
            style.bg = None
            style.bold = False
            style.dim = False
            style.italic = False
            style.underline = False
        elif code == 1:
            style.bold = True
        elif code == 2:
            style.dim = True
        elif code == 3:
            style.italic = True
        elif code == 4:
            style.underline = True
        elif code == 22:
            style.bold = False
            style.dim = False
        elif code == 23:
            style.italic = False
        elif code == 24:
            style.underline = False
        elif 30 <= code <= 37:
            style.fg = ANSI_COLORS[code - 30]
        elif code == 38:
            if index + 2 < len(params) and params[index + 1] == 5:
                style.fg = _color256_to_hex(params[index + 2])
                index += 2
            elif index + 4 < len(params) and params[index + 1] == 2:
                red, green, blue = params[index + 2 : index + 5]
                style.fg = f"rgb({red},{green},{blue})"
                index += 4
        elif code == 39:
            style.fg = None
        elif 40 <= code <= 47:
            style.bg = ANSI_COLORS[code - 40]
        elif code == 48:
            if index + 2 < len(params) and params[index + 1] == 5:
                style.bg = _color256_to_hex(params[index + 2])
                index += 2
            elif index + 4 < len(params) and params[index + 1] == 2:
                red, green, blue = params[index + 2 : index + 5]
                style.bg = f"rgb({red},{green},{blue})"
                index += 4
        elif code == 49:
            style.bg = None
        elif 90 <= code <= 97:
            style.fg = ANSI_COLORS[code - 90 + 8]
        elif 100 <= code <= 107:
            style.bg = ANSI_COLORS[code - 100 + 8]
        index += 1


def ansi_to_html(text: str) -> str:
    style = _TextStyle()
    result: list[str] = []
    last_index = 0
    in_span = False

    for match in ANSI_REGEX.finditer(text):
        before_text = text[last_index : match.start()]
        if before_text:
            result.append(_escape_html(before_text))

        if in_span:
            result.append("</span>")
            in_span = False

        param_str = match.group(1)
        params = [int(part) if part else 0 for part in param_str.split(";")] if param_str else [0]
        _apply_sgr_code(params, style)

        if style.has_style():
            result.append(f'<span style="{style.to_inline_css()}">')
            in_span = True

        last_index = match.end()

    remaining_text = text[last_index:]
    if remaining_text:
        result.append(_escape_html(remaining_text))
    if in_span:
        result.append("</span>")
    return "".join(result)


def ansi_lines_to_html(lines: list[str]) -> str:
    return "".join(
        f'<div class="ansi-line">{ansi_to_html(line) or "&nbsp;"}</div>' for line in lines
    )
