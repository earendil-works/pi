from pi_mono.ai.models import (
    get_model,
    get_providers,
    get_models,
    calculate_cost,
    get_supported_thinking_levels,
    clamp_thinking_level,
    models_are_equal,
)
from pi_mono.ai.image_models import (
    get_image_model,
    get_image_providers,
    get_image_models,
)
from pi_mono.ai.types import Model, Usage


def test_get_providers():
    providers = get_providers()
    assert len(providers) > 0
    assert "anthropic" in providers
    assert "openai" in providers


def test_get_model():
    model = get_model("anthropic", "claude-opus-4-6")
    assert model is not None
    assert model["id"] == "claude-opus-4-6"
    assert model["provider"] == "anthropic"

    model_none = get_model("nonexistent", "model")
    assert model_none is None


def test_get_models():
    models = get_models("anthropic")
    assert len(models) > 0
    assert any(m["id"] == "claude-opus-4-6" for m in models)


def test_calculate_cost():
    model: Model = {
        "id": "test-model",
        "cost": {
            "input": 10.0,
            "output": 30.0,
            "cacheRead": 2.0,
            "cacheWrite": 5.0,
        },
    }
    usage: Usage = {
        "input": 1_000_000,
        "output": 2_000_000,
        "cacheRead": 500_000,
        "cacheWrite": 200_000,
        "totalTokens": 3_700_000,
        "cost": {
            "input": 0.0,
            "output": 0.0,
            "cacheRead": 0.0,
            "cacheWrite": 0.0,
            "total": 0.0,
        },
    }
    cost = calculate_cost(model, usage)
    assert cost["input"] == 10.0
    assert cost["output"] == 60.0
    assert cost["cacheRead"] == 1.0
    assert cost["cacheWrite"] == 1.0
    assert cost["total"] == 72.0


def test_calculate_cost_applies_input_pricing_tiers():
    model: Model = {
        "id": "gpt-5.6-sol",
        "cost": {
            "input": 5.0,
            "output": 30.0,
            "cacheRead": 0.5,
            "cacheWrite": 6.25,
            "tiers": [
                {
                    "inputTokensAbove": 272000,
                    "input": 10.0,
                    "output": 45.0,
                    "cacheRead": 1.0,
                    "cacheWrite": 12.5,
                }
            ],
        },
    }

    def create_usage(cache_write: int) -> Usage:
        return {
            "input": 200000,
            "output": 100000,
            "cacheRead": 72000,
            "cacheWrite": cache_write,
            "totalTokens": 372000 + cache_write,
            "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0},
        }

    short = calculate_cost(model, create_usage(0))
    assert short["input"] == 1.0
    assert short["output"] == 3.0
    assert short["cacheRead"] == 0.036
    assert short["cacheWrite"] == 0.0

    long = calculate_cost(model, create_usage(1))
    assert long["input"] == 2.0
    assert long["output"] == 4.5
    assert long["cacheRead"] == 0.072
    assert long["cacheWrite"] == 0.0000125


def test_get_supported_thinking_levels():
    # Anthropic Opus 4.6 should support max (adaptive thinking)
    model_opus = get_model("anthropic", "claude-opus-4-6")
    assert model_opus is not None
    levels = get_supported_thinking_levels(model_opus)
    assert "max" in levels

    # GPT-5.6 should support max and xhigh
    model_gpt = get_model("openai", "gpt-5.6-sol")
    assert model_gpt is not None
    gpt_levels = get_supported_thinking_levels(model_gpt)
    assert "xhigh" in gpt_levels
    assert "max" in gpt_levels

    # Non-reasoning model
    model_non_reasoning: Model = {"id": "non-reasoning", "reasoning": False}
    assert get_supported_thinking_levels(model_non_reasoning) == ["off"]


def test_clamp_thinking_level():
    model_opus = get_model("anthropic", "claude-opus-4-6")
    assert model_opus is not None

    # Supported thinking level
    assert clamp_thinking_level(model_opus, "max") == "max"
    assert clamp_thinking_level(model_opus, "medium") == "medium"

    # Clamp logic for unsupported or invalid level
    model_limited: Model = {
        "id": "limited",
        "reasoning": True,
        "thinkingLevelMap": {
            "minimal": "low",
            "medium": "medium",
            "high": None,  # explicitly disabled
        },
    }
    # Available levels: "off", "minimal", "low", "medium"
    assert clamp_thinking_level(model_limited, "high") == "medium"
    assert clamp_thinking_level(model_limited, "xhigh") == "medium"
    assert clamp_thinking_level(model_limited, "max") == "medium"


def test_models_are_equal():
    model_a = get_model("anthropic", "claude-opus-4-6")
    model_b = get_model("anthropic", "claude-opus-4-6")
    model_c = get_model("openai", "gpt-4o")

    assert models_are_equal(model_a, model_b) is True
    assert models_are_equal(model_a, model_c) is False
    assert models_are_equal(model_a, None) is False


def test_get_image_providers():
    providers = get_image_providers()
    assert len(providers) > 0
    assert "openrouter" in providers


def test_get_image_model():
    model = get_image_model("openrouter", "google/gemini-2.5-flash-image")
    assert model is not None
    assert model["id"] == "google/gemini-2.5-flash-image"
    assert model["provider"] == "openrouter"


def test_get_image_models():
    models = get_image_models("openrouter")
    assert len(models) > 0
    assert any(m["id"] == "google/gemini-2.5-flash-image" for m in models)


def test_get_cursor_models_merges_generated_catalog_with_discovered() -> None:
    from unittest.mock import patch

    from pi_mono.ai.cursor_agent import refresh_cursor_models_cache

    refresh_cursor_models_cache()
    discovered = [
        {
            "id": "auto",
            "name": "Auto (CLI)",
            "api": "openai-completions",
            "provider": "cursor",
            "baseUrl": "cursor://agent",
            "reasoning": False,
            "input": ["text"],
            "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0},
            "contextWindow": 200000,
            "maxTokens": 32768,
        },
        {
            "id": "composer-2.5",
            "name": "Composer 2.5 (CLI)",
            "api": "openai-completions",
            "provider": "cursor",
            "baseUrl": "cursor://agent",
            "reasoning": False,
            "input": ["text"],
            "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0},
            "contextWindow": 200000,
            "maxTokens": 32768,
        },
    ]
    with patch("pi_mono.ai.models.discover_cursor_models", return_value=discovered):
        models = get_models("cursor")
    ids = [model["id"] for model in models]
    # v0.80+: Cursor models come from CLI discovery (no static catalog entry).
    assert ids[0] == "auto"
    assert models[0]["name"] == "Auto (CLI)"
    assert "composer-2.5" in ids
