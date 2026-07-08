import re
from typing import Any, Pattern, TypedDict


class CostInfo(TypedDict):
    input: float
    output: float
    cacheRead: float
    cacheWrite: float
    total: float


class Usage(TypedDict):
    input: int
    output: int
    cacheRead: int
    cacheWrite: int
    totalTokens: int
    cost: CostInfo


class AssistantMessage(TypedDict, total=False):
    role: str
    content: list[Any]
    api: str
    provider: str
    model: str
    usage: Usage
    stopReason: str
    errorMessage: str
    timestamp: int


OVERFLOW_PATTERNS: list[Pattern[str]] = [
    re.compile(r"prompt is too long", re.IGNORECASE),
    re.compile(r"request_too_large", re.IGNORECASE),
    re.compile(r"input is too long for requested model", re.IGNORECASE),
    re.compile(r"exceeds the context window", re.IGNORECASE),
    re.compile(
        r"exceeds (?:the )?(?:model'?s )?maximum context length of [\d,]+ tokens?",
        re.IGNORECASE,
    ),
    re.compile(r"input token count.*exceeds the maximum", re.IGNORECASE),
    re.compile(r"maximum prompt length is \d+", re.IGNORECASE),
    re.compile(r"reduce the length of the messages", re.IGNORECASE),
    re.compile(r"maximum context length is \d+ tokens", re.IGNORECASE),
    re.compile(
        r"exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?",
        re.IGNORECASE,
    ),
    re.compile(
        r"input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)",
        re.IGNORECASE,
    ),
    re.compile(r"exceeds the limit of \d+", re.IGNORECASE),
    re.compile(r"exceeds the available context size", re.IGNORECASE),
    re.compile(r"greater than the context length", re.IGNORECASE),
    re.compile(r"context window exceeds limit", re.IGNORECASE),
    re.compile(r"exceeded model token limit", re.IGNORECASE),
    re.compile(r"too large for model with \d+ maximum context length", re.IGNORECASE),
    re.compile(r"model_context_window_exceeded", re.IGNORECASE),
    re.compile(r"prompt too long; exceeded (?:max )?context length", re.IGNORECASE),
    re.compile(r"context[_ ]length[_ ]exceeded", re.IGNORECASE),
    re.compile(r"too many tokens", re.IGNORECASE),
    re.compile(r"token limit exceeded", re.IGNORECASE),
    re.compile(r"^4(?:00|13)\s*(?:status code)?\s*\(no body\)", re.IGNORECASE),
]

NON_OVERFLOW_PATTERNS: list[Pattern[str]] = [
    re.compile(r"^(Throttling error|Service unavailable):", re.IGNORECASE),
    re.compile(r"rate limit", re.IGNORECASE),
    re.compile(r"too many requests", re.IGNORECASE),
]


def is_context_overflow(message: AssistantMessage, context_window: int | None = None) -> bool:
    """Check if an assistant message represents a context overflow error."""
    stop_reason = message.get("stopReason")
    error_message = message.get("errorMessage")

    # Case 1: Check error message patterns
    if stop_reason == "error" and error_message:
        is_non_overflow = any(pattern.search(error_message) for pattern in NON_OVERFLOW_PATTERNS)
        if not is_non_overflow and any(
            pattern.search(error_message) for pattern in OVERFLOW_PATTERNS
        ):
            return True

    # Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
    usage = message.get("usage")
    if context_window and stop_reason == "stop" and usage:
        input_tokens = usage.get("input", 0) + usage.get("cacheRead", 0)
        if input_tokens > context_window:
            return True

    # Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates oversized input
    if context_window and stop_reason == "length" and usage and usage.get("output", 0) == 0:
        input_tokens = usage.get("input", 0) + usage.get("cacheRead", 0)
        if input_tokens >= context_window * 0.99:
            return True

    return False


def get_overflow_patterns() -> list[Pattern[str]]:
    """Get the overflow patterns for testing purposes."""
    return list(OVERFLOW_PATTERNS)
