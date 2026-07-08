"""Issue #2791: theme watcher should survive filesystem watch errors."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

theme_module = importlib.import_module("pi_mono.coding_agent.modes.interactive.theme.theme")

_DARK_THEME_PATH = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "pi_mono"
    / "coding_agent"
    / "modes"
    / "interactive"
    / "theme"
    / "dark.json"
)


@pytest.fixture
def custom_theme_agent_dir(tmp_path, monkeypatch):
    agent_dir = tmp_path / "agent"
    themes_dir = agent_dir / "themes"
    themes_dir.mkdir(parents=True)

    dark_theme = json.loads(_DARK_THEME_PATH.read_text(encoding="utf-8"))
    dark_theme["name"] = "custom-test"
    (themes_dir / "custom-test.json").write_text(
        json.dumps(dark_theme, indent=2) + "\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(agent_dir))
    theme_module.stop_theme_watcher()
    yield agent_dir
    theme_module.stop_theme_watcher()


def test_theme_watcher_survives_error_event(custom_theme_agent_dir) -> None:
    """Mirrors TS regression: custom theme watcher must handle error events cleanly."""
    del custom_theme_agent_dir

    result = theme_module.set_theme("custom-test", enable_watcher=True)
    assert result["success"] is True

    watcher = theme_module._theme_watcher
    assert watcher is not None

    try:
        watcher.on_error()
    except Exception as error:  # pragma: no cover - regression guard
        raise AssertionError(f"theme watcher error handler should not raise: {error}") from error

    assert theme_module._theme_watcher is None
