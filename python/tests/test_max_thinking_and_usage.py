"""Tests for max thinking level, pricing tiers, and usage.reasoning."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from pi_mono.ai.providers.openai_completions import parse_chunk_usage
from pi_mono.ai.types import Model
from pi_mono.coding_agent.cli.args import is_valid_thinking_level
from pi_mono.coding_agent.modes.interactive.theme.theme import _load_theme_json, get_theme_by_name
from pi_mono.core.settings_manager import SettingsManager


def test_max_thinking_accepted_by_cli_and_settings() -> None:
    assert is_valid_thinking_level("max") is True

    settings = SettingsManager.in_memory()
    settings.set_default_thinking_level("max")
    assert settings.get_default_thinking_level() == "max"


def test_theme_thinking_max_falls_back_to_xhigh() -> None:
    dark = get_theme_by_name("dark")
    assert "thinkingMax" in dark._fg_ansi

    theme_path = Path(__file__).resolve().parents[1] / (
        "src/pi_mono/coding_agent/modes/interactive/theme/dark.json"
    )
    data = json.loads(theme_path.read_text(encoding="utf-8"))
    del data["colors"]["thinkingMax"]
    data["name"] = "legacy-theme"

    with tempfile.TemporaryDirectory() as tmp:
        legacy_path = Path(tmp) / "legacy-theme.json"
        legacy_path.write_text(json.dumps(data), encoding="utf-8")
        legacy = _load_theme_json(legacy_path)
        assert legacy.get_thinking_border_color("max")("x") == legacy.get_thinking_border_color(
            "xhigh"
        )("x")


def test_parse_chunk_usage_includes_reasoning_tokens() -> None:
    model: Model = {
        "id": "gpt-5.6-sol",
        "cost": {"input": 5.0, "output": 30.0, "cacheRead": 0.5, "cacheWrite": 6.25},
    }
    usage = parse_chunk_usage(
        {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "prompt_tokens_details": {"cached_tokens": 10},
            "completion_tokens_details": {"reasoning_tokens": 12},
        },
        model,
    )
    assert usage["input"] == 90
    assert usage["output"] == 50
    assert usage["cacheRead"] == 10
    assert usage["reasoning"] == 12
    assert usage["totalTokens"] == 150
