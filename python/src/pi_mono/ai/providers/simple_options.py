"""Simple options utilities for building stream options."""

from typing import Any

from pi_mono.ai.types import (
    Context,
    Model,
    SimpleStreamOptions,
    StreamOptions,
    ThinkingBudgets,
    ThinkingLevel,
)
from pi_mono.ai.utils.estimate import estimate_context_tokens

CONTEXT_SAFETY_TOKENS = 4096
MIN_MAX_TOKENS = 1


def clamp_max_tokens_to_context(model: Model[Any], context: Context, max_tokens: int) -> int:
    if int(model.get("contextWindow") or 0) <= 0:
        return max(MIN_MAX_TOKENS, max_tokens)
    available = (
        int(model["contextWindow"])
        - estimate_context_tokens(context).tokens
        - CONTEXT_SAFETY_TOKENS
    )
    return min(max_tokens, max(MIN_MAX_TOKENS, available))


def build_base_options(
    model: Model[Any],
    context: Context,
    options: SimpleStreamOptions | None = None,
    api_key: str | None = None,
) -> StreamOptions:
    """Build base stream options from simple options."""
    opts = options or {}
    requested_max_tokens = opts.get("maxTokens")
    if requested_max_tokens is None:
        requested_max_tokens = int(model.get("maxTokens") or 0)
    return {
        "temperature": opts.get("temperature"),
        "maxTokens": clamp_max_tokens_to_context(model, context, int(requested_max_tokens)),
        "signal": opts.get("signal"),
        "apiKey": api_key or opts.get("apiKey"),
        "transport": opts.get("transport"),
        "cacheRetention": opts.get("cacheRetention"),
        "sessionId": opts.get("sessionId"),
        "headers": opts.get("headers"),
        "onPayload": opts.get("onPayload"),
        "onResponse": opts.get("onResponse"),
        "timeoutMs": opts.get("timeoutMs"),
        "websocketConnectTimeoutMs": opts.get("websocketConnectTimeoutMs"),
        "maxRetries": opts.get("maxRetries"),
        "maxRetryDelayMs": opts.get("maxRetryDelayMs"),
        "metadata": opts.get("metadata"),
    }


def clamp_reasoning(effort: ThinkingLevel | None) -> ThinkingLevel | None:
    """Clamp xhigh/max to high since they're not universally supported."""
    return "high" if effort in ("xhigh", "max") else effort


def adjust_max_tokens_for_thinking(
    base_max_tokens: int | None,
    model_max_tokens: int,
    reasoning_level: ThinkingLevel,
    custom_budgets: ThinkingBudgets | None = None,
) -> dict[str, int]:
    """
    Adjust max tokens to account for thinking budget.

    Returns {"maxTokens": int, "thinkingBudget": int}
    """
    default_budgets: ThinkingBudgets = {
        "minimal": 1024,
        "low": 2048,
        "medium": 8192,
        "high": 16384,
    }
    budgets = {**default_budgets, **(custom_budgets or {})}

    min_output_tokens = 1024
    level = clamp_reasoning(reasoning_level) or "medium"
    thinking_budget = budgets.get(level, 0)

    max_tokens = (
        model_max_tokens
        if base_max_tokens is None
        else min(base_max_tokens + thinking_budget, model_max_tokens)
    )

    if max_tokens <= thinking_budget:
        thinking_budget = max(0, max_tokens - min_output_tokens)

    return {"maxTokens": max_tokens, "thinkingBudget": thinking_budget}
