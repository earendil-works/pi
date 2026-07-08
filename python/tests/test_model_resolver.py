"""Model resolver regressions (ported from model-resolver.test.ts)."""

from __future__ import annotations

from typing import Any

from pi_mono.coding_agent.core.model_resolver import parse_model_pattern, resolve_cli_model


def _openrouter_model(model_id: str) -> dict[str, Any]:
    return {
        "id": model_id,
        "name": model_id,
        "api": "openai-completions",
        "provider": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128000,
        "maxTokens": 8192,
    }


class _Registry:
    def __init__(self, models: list[dict[str, Any]]) -> None:
        self._models = models

    def get_all(self) -> list[dict[str, Any]]:
        return self._models


def test_parse_model_pattern_strict_mode_with_colon_in_model_id() -> None:
    models = [_openrouter_model("openai/gpt-oss-20b:free")]

    result = parse_model_pattern(
        "openai/gpt-oss-20b:free",
        models,
        allow_invalid_thinking_level_fallback=False,
    )

    assert result.model is not None
    assert result.model["id"] == "openai/gpt-oss-20b:free"


def test_resolve_cli_model_openrouter_free_model_not_in_registry() -> None:
    models = [_openrouter_model("moonshotai/kimi-k2.6")]
    registry = _Registry(models)

    result = resolve_cli_model(
        cli_provider="openrouter",
        cli_model="openai/gpt-oss-20b:free",
        model_registry=registry,  # type: ignore[arg-type]
    )

    assert result.error is None
    assert result.model is not None
    assert result.model["provider"] == "openrouter"
    assert result.model["id"] == "openai/gpt-oss-20b:free"
