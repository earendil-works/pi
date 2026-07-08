"""Theme detection and auto-theme setting tests."""

from __future__ import annotations

import pytest

from pi_mono.coding_agent.modes.interactive.theme.theme import (
    detect_terminal_background_from_env,
    get_theme_for_rgb_color,
    parse_auto_theme_setting,
    resolve_theme_setting,
)
from pi_mono.tui.terminal_colors import RgbColor


def test_parse_auto_theme_setting() -> None:
    assert parse_auto_theme_setting("light/dark") == {
        "lightTheme": "light",
        "darkTheme": "dark",
    }
    assert parse_auto_theme_setting("solarized-light/solarized-dark") == {
        "lightTheme": "solarized-light",
        "darkTheme": "solarized-dark",
    }
    assert parse_auto_theme_setting("dark") is None
    assert parse_auto_theme_setting("a/b/c") is None


def test_resolve_theme_setting() -> None:
    assert resolve_theme_setting("light/dark", "light") == "light"
    assert resolve_theme_setting("light/dark", "dark") == "dark"
    assert resolve_theme_setting("solarized", "dark") == "solarized"
    assert resolve_theme_setting("a/b/c", "dark") is None


def test_detect_terminal_background_from_colorfgbg() -> None:
    detection = detect_terminal_background_from_env(env={"COLORFGBG": "0;15"})
    assert detection["source"] == "COLORFGBG"
    assert detection["theme"] == "light"
    assert detection["confidence"] == "high"


def test_detect_terminal_background_fallback() -> None:
    detection = detect_terminal_background_from_env(env={})
    assert detection["source"] == "fallback"
    assert detection["theme"] == "dark"


@pytest.mark.parametrize(
    ("rgb", "expected"),
    [
        (RgbColor(255, 255, 255), "light"),
        (RgbColor(0, 0, 0), "dark"),
        (RgbColor(128, 128, 128), "dark"),
    ],
)
def test_get_theme_for_rgb_color(rgb: RgbColor, expected: str) -> None:
    assert get_theme_for_rgb_color(rgb) == expected
