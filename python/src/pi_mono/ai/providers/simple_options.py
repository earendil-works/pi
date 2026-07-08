"""Simple options utilities for building stream options."""

from typing import Any

from pi_mono.ai.types import (
    Model,
    SimpleStreamOptions,
    StreamOptions,
    ThinkingBudgets,
    ThinkingLevel,
)


def build_base_options(
    model: Model[Any],
    options: SimpleStreamOptions | None = None,
    api_key: str | None = None,
) -> StreamOptions:
    """Build base stream options from simple options."""
    opts = options or {}
    return {
        "temperature": opts.get("temperature"),
        "maxTokens": opts.get("maxTokens"),
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
    """Clamp xhigh to high since it's not universally supported."""
    return "high" if effort == "xhigh" else effort


def adjust_max_tokens_for_thinking(
    base_max_tokens: int | None,
    model_max_tokens: int,
    reasoning_level: ThinkingLevel,
    custom_budgets: ThinkingBudgets | None = None,
) -> tuple[int, int]:
    """
    Adjust max tokens to account for thinking budget.

    Returns (max_tokens, thinking_budget)
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
