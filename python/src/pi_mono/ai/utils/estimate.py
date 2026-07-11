"""Context token estimation utilities."""

from __future__ import annotations

import json
import math
from typing import Any

from pi_mono.ai.types import Context, Message, Usage

CHARS_PER_TOKEN = 4
ESTIMATED_IMAGE_CHARS = 4800


class ContextUsageEstimate:
    def __init__(
        self,
        tokens: int,
        usage_tokens: int,
        trailing_tokens: int,
        last_usage_index: int | None,
    ):
        self.tokens = tokens
        self.usage_tokens = usage_tokens
        self.trailing_tokens = trailing_tokens
        self.last_usage_index = last_usage_index

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ContextUsageEstimate):
            if isinstance(other, dict):
                return (
                    self.tokens == other.get("tokens")
                    and self.usage_tokens == other.get("usageTokens")
                    and self.trailing_tokens == other.get("trailingTokens")
                    and self.last_usage_index == other.get("lastUsageIndex")
                )
            return False
        return (
            self.tokens == other.tokens
            and self.usage_tokens == other.usage_tokens
            and self.trailing_tokens == other.trailing_tokens
            and self.last_usage_index == other.last_usage_index
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "tokens": self.tokens,
            "usageTokens": self.usage_tokens,
            "trailingTokens": self.trailing_tokens,
            "lastUsageIndex": self.last_usage_index,
        }


def calculate_context_tokens(usage: Usage) -> int:
    return usage.get("totalTokens") or (
        usage.get("input", 0)
        + usage.get("output", 0)
        + usage.get("cacheRead", 0)
        + usage.get("cacheWrite", 0)
    )


def _safe_json_stringify(value: Any) -> str:
    try:
        result = json.dumps(value)
        return result if result is not None else "undefined"
    except (TypeError, ValueError):
        return "[unserializable]"


def _estimate_text_and_image_content_chars(content: str | list[dict[str, Any]]) -> int:
    if isinstance(content, str):
        return len(content)
    chars = 0
    for block in content:
        if block.get("type") == "text":
            chars += len(str(block.get("text", "")))
        else:
            chars += ESTIMATED_IMAGE_CHARS
    return chars


def estimate_text_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def estimate_text_and_image_content_tokens(content: str | list[dict[str, Any]]) -> int:
    return math.ceil(_estimate_text_and_image_content_chars(content) / CHARS_PER_TOKEN)


def estimate_message_tokens(message: Message) -> int:
    role = message.get("role")
    content = message.get("content")
    if role in ("user", "toolResult"):
        if content is None:
            return 0
        return estimate_text_and_image_content_tokens(content)  # type: ignore[arg-type]

    chars = 0
    for block in content or []:
        block_type = block.get("type")
        if block_type == "text":
            chars += len(str(block.get("text", "")))
        elif block_type == "thinking":
            chars += len(str(block.get("thinking", "")))
        else:
            chars += len(str(block.get("name", ""))) + len(
                _safe_json_stringify(block.get("arguments"))
            )
    return math.ceil(chars / CHARS_PER_TOKEN)


def _get_last_assistant_usage_info(
    messages: list[Message],
) -> dict[str, Any] | None:
    latest_prefix_timestamp = float("-inf")
    usage_info: dict[str, Any] | None = None

    for i, message in enumerate(messages):
        if message.get("role") == "assistant":
            # A newer prefix message was inserted after this response (for example, a
            # compaction summary), so its usage cannot describe the current prefix.
            timestamp = message.get("timestamp")
            usage_applies_to_prefix = (
                timestamp is not None and timestamp >= latest_prefix_timestamp
            )
            usage = message.get("usage")
            if (
                usage_applies_to_prefix
                and message.get("stopReason") not in ("aborted", "error")
                and usage
                and calculate_context_tokens(usage) > 0
            ):
                usage_info = {"usage": usage, "index": i}
        msg_timestamp = message.get("timestamp")
        if msg_timestamp is not None:
            latest_prefix_timestamp = max(latest_prefix_timestamp, msg_timestamp)

    return usage_info


def _estimate_messages(messages: list[Message]) -> ContextUsageEstimate:
    usage_info = _get_last_assistant_usage_info(messages)
    if usage_info:
        usage_tokens = calculate_context_tokens(usage_info["usage"])
        trailing_tokens = sum(
            estimate_message_tokens(messages[i])
            for i in range(usage_info["index"] + 1, len(messages))
        )
        return ContextUsageEstimate(
            usage_tokens + trailing_tokens,
            usage_tokens,
            trailing_tokens,
            usage_info["index"],
        )

    tokens = sum(estimate_message_tokens(message) for message in messages)
    return ContextUsageEstimate(tokens, 0, tokens, None)


def estimate_context_tokens(context: Context | list[Message]) -> ContextUsageEstimate:
    if isinstance(context, list):
        return _estimate_messages(context)

    messages = list(context.get("messages") or [])
    estimate = _estimate_messages(messages)
    if estimate.last_usage_index is not None:
        return estimate

    prefix_tokens = 0
    system_prompt = context.get("systemPrompt")
    if system_prompt:
        prefix_tokens += estimate_text_tokens(system_prompt)
    tools = context.get("tools")
    if tools:
        prefix_tokens += estimate_text_tokens(_safe_json_stringify(tools))

    return ContextUsageEstimate(
        estimate.tokens + prefix_tokens,
        estimate.usage_tokens,
        estimate.trailing_tokens + prefix_tokens,
        estimate.last_usage_index,
    )
