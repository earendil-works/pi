
from pi_mono.ai.cursor_agent import discover_cursor_models
from pi_mono.ai.types import (
    CostBreakdown,
    Model,
    ModelCostRates,
    ModelThinkingLevel,
    Usage,
)
from pi_mono.ai.models_generated import MODELS

model_registry: dict[str, dict[str, Model]] = {}

# Initialize registry
for provider, models in MODELS.items():
    model_registry[provider] = {id: m for id, m in models.items()}


def get_model(provider: str, model_id: str) -> Model | None:
    provider_models = model_registry.get(provider)
    if provider_models is None:
        return None
    return provider_models.get(model_id)


def get_providers() -> list[str]:
    providers = list(model_registry.keys())
    if "cursor" not in providers:
        providers.append("cursor")
    return providers


def _merge_cursor_models(discovered: list[Model], generated: list[Model]) -> list[Model]:
    merged = list(discovered)
    seen = {model["id"] for model in discovered}
    for model in generated:
        if model["id"] not in seen:
            merged.append(model)
            seen.add(model["id"])
    return merged


def get_models(provider: str) -> list[Model]:
    if provider == "cursor":
        generated = list(model_registry.get("cursor", {}).values())
        return _merge_cursor_models(discover_cursor_models(), generated)
    models = model_registry.get(provider)
    return list(models.values()) if models else []


def calculate_cost(model: Model, usage: Usage) -> CostBreakdown:
    input_tokens = usage["input"] + usage["cacheRead"] + usage["cacheWrite"]
    rates: ModelCostRates = {
        "input": model["cost"]["input"],
        "output": model["cost"]["output"],
        "cacheRead": model["cost"]["cacheRead"],
        "cacheWrite": model["cost"]["cacheWrite"],
    }
    matched_threshold = -1
    for tier in model["cost"].get("tiers") or []:
        if input_tokens > tier["inputTokensAbove"] and tier["inputTokensAbove"] > matched_threshold:
            rates = {
                "input": tier["input"],
                "output": tier["output"],
                "cacheRead": tier["cacheRead"],
                "cacheWrite": tier["cacheWrite"],
            }
            matched_threshold = tier["inputTokensAbove"]

    # Anthropic charges 2x base input for 1h cache writes.
    long_write = usage.get("cacheWrite1h") or 0
    short_write = usage["cacheWrite"] - long_write

    cost = usage["cost"]
    cost["input"] = (rates["input"] / 1000000.0) * usage["input"]
    cost["output"] = (rates["output"] / 1000000.0) * usage["output"]
    cost["cacheRead"] = (rates["cacheRead"] / 1000000.0) * usage["cacheRead"]
    cost["cacheWrite"] = (
        rates["cacheWrite"] * short_write + rates["input"] * 2 * long_write
    ) / 1000000.0
    cost["total"] = cost["input"] + cost["output"] + cost["cacheRead"] + cost["cacheWrite"]
    return cost


EXTENDED_THINKING_LEVELS: list[ModelThinkingLevel] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]


def get_supported_thinking_levels(model: Model) -> list[ModelThinkingLevel]:
    if not model.get("reasoning"):
        return ["off"]

    thinking_level_map = model.get("thinkingLevelMap") or {}
    result: list[ModelThinkingLevel] = []
    for level in EXTENDED_THINKING_LEVELS:
        if level in thinking_level_map:
            mapped = thinking_level_map[level]
            if mapped is None:
                continue
            result.append(level)
        else:
            if level in ("xhigh", "max"):
                continue
            result.append(level)
    return result


def clamp_thinking_level(model: Model, level: ModelThinkingLevel) -> ModelThinkingLevel:
    available_levels = get_supported_thinking_levels(model)
    if level in available_levels:
        return level

    try:
        requested_index = EXTENDED_THINKING_LEVELS.index(level)
    except ValueError:
        return available_levels[0] if available_levels else "off"

    for i in range(requested_index, len(EXTENDED_THINKING_LEVELS)):
        candidate = EXTENDED_THINKING_LEVELS[i]
        if candidate in available_levels:
            return candidate

    for i in range(requested_index - 1, -1, -1):
        candidate = EXTENDED_THINKING_LEVELS[i]
        if candidate in available_levels:
            return candidate

    return available_levels[0] if available_levels else "off"


def models_are_equal(a: Model | None, b: Model | None) -> bool:
    if a is None or b is None:
        return False
    return a.get("id") == b.get("id") and a.get("provider") == b.get("provider")
