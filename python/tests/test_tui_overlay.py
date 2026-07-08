"""TUI overlay sizing and handle tests."""

from __future__ import annotations

from unittest.mock import MagicMock

from pi_mono.tui.tui import OverlayOptions, TUI, parse_size_value


def test_parse_size_value_percentage() -> None:
    assert parse_size_value("80%", 24) == 19
    assert parse_size_value(10, 24) == 10
    assert parse_size_value(None, 24) is None


def test_show_overlay_returns_handle_with_percentage_max_height() -> None:
    terminal = MagicMock()
    terminal.columns = 80
    terminal.rows = 24
    terminal.kittyProtocolActive = False
    ui = TUI(terminal)

    overlay = MagicMock()
    overlay.render.return_value = ["line"]

    handle = ui.show_overlay(overlay, OverlayOptions(anchor="center", max_height="80%"))
    handle.hide()

    assert handle.is_hidden() is False
    assert ui.overlay_stack == []
