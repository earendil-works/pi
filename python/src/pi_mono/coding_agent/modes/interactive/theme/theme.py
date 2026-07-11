"""Simplified theme support for the interactive TUI."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict

from pi_mono.tui.terminal_colors import RgbColor
from pi_mono.tui.components.editor import EditorTheme
from pi_mono.tui.components.markdown import MarkdownTheme
from pi_mono.tui.components.select_list import SelectListTheme
from pi_mono.config import get_custom_themes_dir
from pi_mono.tui.components.settings_list import SettingsListTheme
from pi_mono.utils.fs_watch import FSWatcher, close_watcher, watch_with_error_handler

THEMES_DIR = Path(__file__).resolve().parent

ThemeColorFn = Callable[[str], str]


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    cleaned = hex_color.lstrip("#")
    if len(cleaned) != 6:
        raise ValueError(f"Invalid hex color: {hex_color}")
    return int(cleaned[0:2], 16), int(cleaned[2:4], 16), int(cleaned[4:6], 16)


def _fg_ansi(color: str | int) -> str:
    if color == "":
        return "\x1b[39m"
    if isinstance(color, int):
        return f"\x1b[38;5;{color}m"
    if isinstance(color, str) and color.startswith("#"):
        r, g, b = _hex_to_rgb(color)
        return f"\x1b[38;2;{r};{g};{b}m"
    raise ValueError(f"Invalid color value: {color}")


def _bg_ansi(color: str | int) -> str:
    if color == "":
        return "\x1b[49m"
    if isinstance(color, int):
        return f"\x1b[48;5;{color}m"
    if isinstance(color, str) and color.startswith("#"):
        r, g, b = _hex_to_rgb(color)
        return f"\x1b[48;2;{r};{g};{b}m"
    raise ValueError(f"Invalid color value: {color}")


def _resolve_var_refs(
    value: str | int,
    vars_map: dict[str, str | int],
    visited: set[str] | None = None,
) -> str | int:
    if isinstance(value, int) or value == "" or (isinstance(value, str) and value.startswith("#")):
        return value
    seen = visited or set()
    if value in seen:
        raise ValueError(f"Circular variable reference detected: {value}")
    if value not in vars_map:
        raise ValueError(f"Variable reference not found: {value}")
    seen.add(value)
    return _resolve_var_refs(vars_map[value], vars_map, seen)


def _resolve_theme_colors(
    colors: dict[str, str | int],
    vars_map: dict[str, str | int],
) -> dict[str, str | int]:
    return {key: _resolve_var_refs(value, vars_map) for key, value in colors.items()}


class Theme:
    """Terminal color theme."""

    def __init__(
        self,
        fg_colors: dict[str, str | int],
        bg_colors: dict[str, str | int],
        *,
        name: str | None = None,
    ) -> None:
        self.name = name
        self._fg_ansi = {key: _fg_ansi(value) for key, value in fg_colors.items()}
        self._bg_ansi = {key: _bg_ansi(value) for key, value in bg_colors.items()}

    def fg(self, color: str, text: str) -> str:
        ansi = self._fg_ansi.get(color)
        if ansi is None:
            raise KeyError(f"Unknown theme color: {color}")
        return f"{ansi}{text}\x1b[39m"

    def fg_fn(self, color: str) -> ThemeColorFn:
        return lambda text: self.fg(color, text)

    def bg(self, color: str, text: str) -> str:
        ansi = self._bg_ansi.get(color)
        if ansi is None:
            raise KeyError(f"Unknown theme background color: {color}")
        return f"{ansi}{text}\x1b[49m"

    def bg_fn(self, color: str) -> ThemeColorFn:
        return lambda text: self.bg(color, text)

    def bold(self, text: str) -> str:
        return f"\x1b[1m{text}\x1b[22m"

    def italic(self, text: str) -> str:
        return f"\x1b[3m{text}\x1b[23m"

    def underline(self, text: str) -> str:
        return f"\x1b[4m{text}\x1b[24m"

    def inverse(self, text: str) -> str:
        return f"\x1b[7m{text}\x1b[27m"

    def get_thinking_border_color(self, level: str) -> ThemeColorFn:
        color_map = {
            "off": "thinkingOff",
            "minimal": "thinkingMinimal",
            "low": "thinkingLow",
            "medium": "thinkingMedium",
            "high": "thinkingHigh",
            "xhigh": "thinkingXhigh",
            "max": "thinkingMax",
        }
        color = color_map.get(level, "thinkingOff")
        if color not in self._fg_ansi:
            color = "thinkingXhigh" if level == "max" else "thinkingOff"
        return self.fg_fn(color)


def _load_theme_json(path: Path) -> Theme:
    with path.open(encoding="utf-8") as handle:
        data: dict[str, Any] = json.load(handle)
    vars_map = data.get("vars", {})
    colors = _resolve_theme_colors(data["colors"], vars_map)
    # thinkingMax is optional for legacy themes; fall back to thinkingXhigh.
    if "thinkingMax" not in colors and "thinkingXhigh" in colors:
        colors["thinkingMax"] = colors["thinkingXhigh"]
    fg_colors = {key: value for key, value in colors.items() if not key.endswith("Bg")}
    bg_keys = (
        "selectedBg",
        "userMessageBg",
        "customMessageBg",
        "toolPendingBg",
        "toolSuccessBg",
        "toolErrorBg",
    )
    bg_colors = {key: colors[key] for key in bg_keys if key in colors}
    return Theme(fg_colors, bg_colors, name=data.get("name"))


def get_theme_by_name(name: str) -> Theme:
    path = THEMES_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(f"Theme not found: {name}")
    return _load_theme_json(path)


def get_available_themes() -> list[str]:
    return sorted(path.stem for path in THEMES_DIR.glob("*.json"))


def get_markdown_theme() -> MarkdownTheme:
    return MarkdownTheme(
        heading=theme.fg_fn("mdHeading"),
        link=theme.fg_fn("mdLink"),
        link_url=theme.fg_fn("mdLinkUrl"),
        code=theme.fg_fn("mdCode"),
        code_block=theme.fg_fn("mdCodeBlock"),
        code_block_border=theme.fg_fn("mdCodeBlockBorder"),
        quote=theme.fg_fn("mdQuote"),
        quote_border=theme.fg_fn("mdQuoteBorder"),
        hr=theme.fg_fn("mdHr"),
        list_bullet=theme.fg_fn("mdListBullet"),
        bold=theme.bold,
        italic=theme.italic,
        strikethrough=lambda text: f"\x1b[9m{text}\x1b[29m",
        underline=theme.underline,
    )


def get_select_list_theme() -> SelectListTheme:
    return SelectListTheme(
        selected_prefix=theme.fg_fn("accent"),
        selected_text=theme.fg_fn("text"),
        description=theme.fg_fn("muted"),
        scroll_info=theme.fg_fn("dim"),
        no_match=theme.fg_fn("error"),
    )


def get_settings_list_theme() -> SettingsListTheme:
    return SettingsListTheme(
        label=lambda text, selected: theme.fg("accent", text) if selected else text,
        value=lambda text, selected: (
            theme.fg("accent", text) if selected else theme.fg("muted", text)
        ),
        description=lambda text: theme.fg("dim", text),
        cursor=theme.fg("accent", "→ "),
        hint=lambda text: theme.fg("dim", text),
    )


def get_editor_theme() -> EditorTheme:
    return EditorTheme(
        border_color=theme.fg_fn("border"),
        select_list=get_select_list_theme(),
    )


_default_theme_name = "dark"
if os.environ.get("COLORFGBG", "").endswith(";15") or os.environ.get("PI_THEME") == "light":
    _default_theme_name = "light"

theme = get_theme_by_name(_default_theme_name)

_theme_watcher: FSWatcher | None = None
_theme_watcher_path: str | None = None


def start_theme_watcher(theme_path: str, on_change: Callable[[], None]) -> None:
    """Watch a custom theme file and reload when it changes."""
    global _theme_watcher, _theme_watcher_path
    stop_theme_watcher()
    _theme_watcher_path = theme_path

    def listener(_event_type: str, _filename: str) -> None:
        on_change()

    def on_error() -> None:
        stop_theme_watcher()

    _theme_watcher = watch_with_error_handler(theme_path, listener, on_error)


def stop_theme_watcher() -> None:
    global _theme_watcher, _theme_watcher_path
    close_watcher(_theme_watcher)
    _theme_watcher = None
    _theme_watcher_path = None


def reload_theme_from_path(theme_path: str) -> Theme:
    global theme
    theme = _load_theme_json(Path(theme_path))
    return theme


def get_custom_theme_path(name: str) -> Path | None:
    candidate = get_custom_themes_dir() / f"{name}.json"
    return candidate if candidate.exists() else None


TerminalTheme = Literal["dark", "light"]


class TerminalThemeDetection(TypedDict):
    theme: TerminalTheme
    source: Literal["terminal background", "COLORFGBG", "fallback"]
    detail: str
    confidence: Literal["high", "low"]


class TerminalBackgroundThemeDetector(Protocol):
    async def query_terminal_background_color(self, *, timeout_ms: int) -> RgbColor | None: ...


_on_theme_change_callback: Callable[[], None] | None = None


def on_theme_change(callback: Callable[[], None]) -> None:
    global _on_theme_change_callback
    _on_theme_change_callback = callback


def parse_auto_theme_setting(theme_setting: str | None) -> dict[str, str] | None:
    if not theme_setting:
        return None
    slash_index = theme_setting.find("/")
    if slash_index == -1 or theme_setting.find("/", slash_index + 1) != -1:
        return None
    light_theme = theme_setting[:slash_index].strip()
    dark_theme = theme_setting[slash_index + 1 :].strip()
    if not light_theme or not dark_theme:
        return None
    return {"lightTheme": light_theme, "darkTheme": dark_theme}


def resolve_theme_setting(theme_setting: str | None, terminal_theme: TerminalTheme) -> str | None:
    auto_theme = parse_auto_theme_setting(theme_setting)
    if auto_theme:
        return auto_theme["lightTheme"] if terminal_theme == "light" else auto_theme["darkTheme"]
    if theme_setting and "/" in theme_setting:
        return None
    return theme_setting


def _get_color_fgbg_background_index(colorfgbg: str) -> int | None:
    for part in reversed(colorfgbg.split(";")):
        stripped = part.strip()
        if stripped.isdigit():
            value = int(stripped)
            if 0 <= value <= 255:
                return value
    return None


def _ansi256_to_rgb(index: int) -> tuple[int, int, int]:
    if index < 16:
        base = [
            (0, 0, 0),
            (128, 0, 0),
            (0, 128, 0),
            (128, 128, 0),
            (0, 0, 128),
            (128, 0, 128),
            (0, 128, 128),
            (192, 192, 192),
            (128, 128, 128),
            (255, 0, 0),
            (0, 255, 0),
            (255, 255, 0),
            (0, 0, 255),
            (255, 0, 255),
            (0, 255, 255),
            (255, 255, 255),
        ]
        return base[index]
    if index < 232:
        index -= 16
        r = (index // 36) % 6
        g = (index // 6) % 6
        b = index % 6
        cube = [0, 95, 135, 175, 215, 255]
        return cube[r], cube[g], cube[b]
    gray = 8 + (index - 232) * 10
    return gray, gray, gray


def _get_rgb_color_luminance(rgb: RgbColor) -> float:
    def to_linear(channel: int) -> float:
        value = channel / 255
        if value <= 0.03928:
            return value / 12.92
        return ((value + 0.055) / 1.055) ** 2.4

    return 0.2126 * to_linear(rgb.r) + 0.7152 * to_linear(rgb.g) + 0.0722 * to_linear(rgb.b)


def get_theme_for_rgb_color(rgb: RgbColor) -> TerminalTheme:
    return "light" if _get_rgb_color_luminance(rgb) >= 0.5 else "dark"


def detect_terminal_background_from_env(
    *, env: dict[str, str] | None = None
) -> TerminalThemeDetection:
    values = env or os.environ
    colorfgbg = values.get("COLORFGBG", "")
    bg = _get_color_fgbg_background_index(colorfgbg)
    if bg is not None:
        r, g, b = _ansi256_to_rgb(bg)
        theme_name: TerminalTheme = (
            "light" if _get_rgb_color_luminance(RgbColor(r, g, b)) >= 0.5 else "dark"
        )
        return {
            "theme": theme_name,
            "source": "COLORFGBG",
            "detail": f"background color index {bg}",
            "confidence": "high",
        }
    return {
        "theme": "dark",
        "source": "fallback",
        "detail": "no terminal background hint found",
        "confidence": "low",
    }


async def detect_terminal_background_theme(
    *,
    ui: TerminalBackgroundThemeDetector,
    timeout_ms: int,
    env: dict[str, str] | None = None,
) -> TerminalThemeDetection:
    try:
        rgb = await ui.query_terminal_background_color(timeout_ms=timeout_ms)
        if rgb is not None:
            return {
                "theme": get_theme_for_rgb_color(rgb),
                "source": "terminal background",
                "detail": f"OSC 11 background rgb({rgb.r}, {rgb.g}, {rgb.b})",
                "confidence": "high",
            }
    except Exception:
        pass
    return detect_terminal_background_from_env(env=env)


def get_default_theme() -> str:
    return detect_terminal_background_from_env()["theme"]


def set_theme(name: str, *, enable_watcher: bool = False) -> dict[str, Any]:
    global theme
    try:
        custom_path = get_custom_theme_path(name)
        if custom_path is not None:
            theme = _load_theme_json(custom_path)
            if enable_watcher:
                start_theme_watcher(
                    str(custom_path),
                    lambda: reload_theme_from_path(str(custom_path)),
                )
        else:
            theme = get_theme_by_name(name)
            if enable_watcher:
                stop_theme_watcher()
        if _on_theme_change_callback is not None:
            _on_theme_change_callback()
        return {"success": True}
    except Exception as error:
        theme = get_theme_by_name("dark")
        stop_theme_watcher()
        return {"success": False, "error": str(error)}


def set_theme_instance(theme_instance: Theme) -> None:
    global theme
    theme = theme_instance
    stop_theme_watcher()
    if _on_theme_change_callback is not None:
        _on_theme_change_callback()


def init_theme(name: str | None = None, enable_watcher: bool = False) -> Theme:
    resolved = name or get_default_theme()
    set_theme(resolved, enable_watcher=enable_watcher)
    return theme
