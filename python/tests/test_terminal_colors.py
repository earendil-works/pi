"""Terminal OSC color parsing tests ported from terminal-colors.test.ts."""

from __future__ import annotations

from pi_mono.tui.terminal_colors import (
    RgbColor,
    is_osc11_background_color_response,
    parse_osc11_background_color,
    parse_terminal_color_scheme_report,
)


def test_parse_osc11_background_color_rgb_channels() -> None:
    assert parse_osc11_background_color("\x1b]11;rgb:0000/8000/ffff\x07") == RgbColor(
        r=0, g=128, b=255
    )


def test_parse_osc11_background_color_hex() -> None:
    assert parse_osc11_background_color("\x1b]11;#ffffff\x1b\\") == RgbColor(r=255, g=255, b=255)
    assert parse_osc11_background_color("\x1b]11;#000000\x07") == RgbColor(r=0, g=0, b=0)


def test_parse_osc11_background_color_rejects_non_strict_responses() -> None:
    assert parse_osc11_background_color("x\x1b]11;#ffffff\x07") is None
    assert parse_osc11_background_color("\x1b]10;#ffffff\x07") is None
    assert parse_osc11_background_color("\x1b]11;#ffffff\x07x") is None


def test_is_osc11_background_color_response() -> None:
    assert is_osc11_background_color_response("\x1b]11;#ffffff\x07") is True
    assert is_osc11_background_color_response("\x1b]10;#ffffff\x07") is False


def test_parse_terminal_color_scheme_report() -> None:
    assert parse_terminal_color_scheme_report("\x1b[?997;1n") == "dark"
    assert parse_terminal_color_scheme_report("\x1b[?997;2n") == "light"
    assert parse_terminal_color_scheme_report("\x1b[?997;3n") is None
    assert parse_terminal_color_scheme_report("\x1b[?996n") is None
    assert parse_terminal_color_scheme_report("x\x1b[?997;1n") is None
