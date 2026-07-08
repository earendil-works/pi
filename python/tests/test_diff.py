"""Tests for interactive diff rendering."""

from __future__ import annotations

from pi_mono.coding_agent.modes.interactive.components.diff import render_diff
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.utils.ansi import strip_ansi


def test_render_diff_colors_context_removed_and_added() -> None:
    init_theme()
    diff_text = "  1 unchanged\n-  2 remove me\n+  2 add me"
    rendered = render_diff(diff_text)
    plain = strip_ansi(rendered)
    assert "unchanged" in plain
    assert "remove me" in plain
    assert "add me" in plain
    assert "\x1b[31m" in rendered or "\x1b[38;" in rendered


def test_render_diff_intra_line_highlights_changed_tokens() -> None:
    init_theme()
    diff_text = "-  1 hello world\n+  1 hello brave world"
    rendered = render_diff(diff_text)
    assert "\x1b[7m" in rendered
    plain = strip_ansi(rendered)
    assert "hello" in plain
    assert "brave" in plain


def test_render_diff_replaces_tabs() -> None:
    init_theme()
    diff_text = "-  1 hello\tworld\n+  1 hello\tbrave"
    rendered = render_diff(diff_text)
    assert "\t" not in strip_ansi(rendered)
