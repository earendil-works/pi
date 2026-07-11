"""Classify whether a failed assistant message looks retryable."""

from __future__ import annotations

import re

from pi_mono.ai.types import AssistantMessage

_NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = re.compile(
    r"GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|"
    r"insufficient_quota|out of budget|quota exceeded|billing",
    re.IGNORECASE,
)

_RETRYABLE_PROVIDER_ERROR_PATTERN = re.compile(
    r"overloaded|rate.?limit|too many requests|429|500|502|503|504|524|"
    r"service.?unavailable|server.?error|internal.?error|"
    r"provider.?returned.?error|"
    r"network.?error|connection.?error|connection.?refused|connection.?lost|"
    r"other side closed|fetch failed|upstream.?connect|reset before headers|"
    r"socket hang up|socket connection was closed|timed? out|timeout|terminated|"
    r"websocket.?closed|websocket.?error|"
    r"ended without|stream ended before message_stop|http2 request did not get a response|"
    r"retry delay|"
    r"you can retry your request|try your request again|please retry your request|"
    r"ResourceExhausted",
    re.IGNORECASE,
)


def is_retryable_assistant_error(message: AssistantMessage) -> bool:
    """Return True when the assistant error looks like a transient provider/transport failure.

    Does not implement retry policy. Callers should handle context overflow separately,
    then apply their own retry budget and backoff.
    """
    if message.get("stopReason") != "error" or not message.get("errorMessage"):
        return False
    error_message = str(message.get("errorMessage", ""))
    if _NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.search(error_message):
        return False
    return bool(_RETRYABLE_PROVIDER_ERROR_PATTERN.search(error_message))
