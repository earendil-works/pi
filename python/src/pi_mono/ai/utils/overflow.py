"""Context overflow detection utilities for AI providers."""

import re

from pi_mono.ai.types import AssistantMessage

# Regex patterns to detect context overflow errors from different providers
OVERFLOW_PATTERNS: list[re.Pattern] = [
    re.compile(r"prompt is too long", re.IGNORECASE),  # Anthropic token overflow
    re.compile(
        r"request_too_large", re.IGNORECASE
    ),  # Anthropic request byte-size overflow (HTTP 413)
    re.compile(r"input is too long for requested model", re.IGNORECASE),  # Amazon Bedrock
    re.compile(
        r"exceeds the context window", re.IGNORECASE
    ),  # OpenAI (Completions & Responses API)
    re.compile(
        r"exceeds (?:the )?(?:model'?s )?maximum context length of [\d,]+ tokens?", re.IGNORECASE
    ),  # OpenAI-compatible proxies (LiteLLM)
    re.compile(r"input token count.*exceeds the maximum", re.IGNORECASE),  # Google (Gemini)
    re.compile(r"maximum prompt length is \d+", re.IGNORECASE),  # xAI (Grok)
    re.compile(r"reduce the length of the messages", re.IGNORECASE),  # Groq
    re.compile(
        r"maximum context length is \d+ tokens", re.IGNORECASE
    ),  # OpenRouter (most backends)
    re.compile(
        r"exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?", re.IGNORECASE
    ),  # OpenRouter/Poolside
    re.compile(
        r"input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)",
        re.IGNORECASE,
    ),  # Together AI
    re.compile(r"exceeds the limit of \d+", re.IGNORECASE),  # GitHub Copilot
    re.compile(r"exceeds the available context size", re.IGNORECASE),  # llama.cpp server
    re.compile(r"greater than the context length", re.IGNORECASE),  # LM Studio
    re.compile(r"context window exceeds limit", re.IGNORECASE),  # MiniMax
    re.compile(r"exceeded model token limit", re.IGNORECASE),  # Kimi For Coding
    re.compile(r"too large for model with \d+ maximum context length", re.IGNORECASE),  # Mistral
    re.compile(r"model_context_window_exceeded", re.IGNORECASE),  # z.ai non-standard finish_reason
    re.compile(
        r"prompt too long; exceeded (?:max )?context length", re.IGNORECASE
    ),  # Ollama explicit overflow error
    re.compile(r"context[_ ]length[_ ]exceeded", re.IGNORECASE),  # Generic fallback
    re.compile(r"too many tokens", re.IGNORECASE),  # Generic fallback
    re.compile(r"token limit exceeded", re.IGNORECASE),  # Generic fallback
    re.compile(
        r"^4(?:00|13)\s*(?:status code)?\s*\(no body\)", re.IGNORECASE
    ),  # Cerebras: 400/413 with no body
]

# Patterns that indicate non-overflow errors (e.g. rate limiting, server errors)
NON_OVERFLOW_PATTERNS: list[re.Pattern] = [
    re.compile(
        r"^(Throttling error|Service unavailable):", re.IGNORECASE
    ),  # AWS Bedrock non-overflow errors
    re.compile(r"rate limit", re.IGNORECASE),  # Generic rate limiting
    re.compile(r"too many requests", re.IGNORECASE),  # Generic HTTP 429 style
]


def is_context_overflow(message: AssistantMessage, context_window: int | None = None) -> bool:
    """
    Check if an assistant message represents a context overflow error.

    This handles two cases:
    1. Error-based overflow: Most providers return stopReason "error" with a
       specific error message pattern.
    2. Silent overflow: Some providers accept overflow requests and return
       successfully. For these, we check if usage.input exceeds the context window.

    Args:
        message: The assistant message to check
        context_window: Optional context window size for detecting silent overflow (z.ai, Xiaomi MiMo)

    Returns:
        True if the message indicates a context overflow
    """
    # Case 1: Check error message patterns
    if message.get("stopReason") == "error" and message.get("errorMessage"):
        error_msg = message["errorMessage"]

        # Skip messages matching known non-overflow patterns (e.g. throttling / rate-limit)
        is_non_overflow = any(p.search(error_msg) for p in NON_OVERFLOW_PATTERNS)
        if not is_non_overflow and any(p.search(error_msg) for p in OVERFLOW_PATTERNS):
            return True

    # Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
    if context_window and message.get("stopReason") == "stop":
        usage = message.get("usage", {})
        input_tokens = usage.get("input", 0) + usage.get("cacheRead", 0)
        if input_tokens > context_window:
            return True

    # Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates oversized input
    # to fit the context window, leaving no room for output. Returns stopReason "length"
    # with output=0 and input+cacheRead filling the context window.
    if (
        context_window
        and message.get("stopReason") == "length"
        and message.get("usage", {}).get("output", 0) == 0
    ):
        usage = message.get("usage", {})
        input_tokens = usage.get("input", 0) + usage.get("cacheRead", 0)
        if input_tokens >= context_window * 0.99:
            return True

    return False


def get_overflow_patterns() -> list[re.Pattern]:
    """Get the overflow patterns for testing purposes."""
    return list(OVERFLOW_PATTERNS)
