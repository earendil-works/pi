"""Message transformation utilities for cross-provider compatibility."""

from typing import Any

from pi_mono.ai.types import (
    AssistantMessage,
    ImageContent,
    Message,
    Model,
    TextContent,
    ToolCall,
)

NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)"
NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)"


def _replace_images_with_placeholder(
    content: list[TextContent | ImageContent], placeholder: str
) -> list[TextContent]:
    result: list[TextContent] = []
    previous_was_placeholder = False

    for block in content:
        if block["type"] == "image":
            if not previous_was_placeholder:
                result.append({"type": "text", "text": placeholder})
            previous_was_placeholder = True
            continue

        result.append(block)
        previous_was_placeholder = block.get("text", "") == placeholder

    return result


def _downgrade_unsupported_images(messages: list[Message], model: Model[Any]) -> list[Message]:
    if "image" in model.get("input", []):
        return messages

    downgraded = []
    for msg in messages:
        if msg["role"] == "user" and isinstance(msg.get("content"), list):
            downgraded.append(
                {
                    **msg,
                    "content": _replace_images_with_placeholder(
                        msg["content"], NON_VISION_USER_IMAGE_PLACEHOLDER
                    ),
                }
            )
        elif msg["role"] == "toolResult":
            downgraded.append(
                {
                    **msg,
                    "content": _replace_images_with_placeholder(
                        msg["content"], NON_VISION_TOOL_IMAGE_PLACEHOLDER
                    ),
                }
            )
        else:
            downgraded.append(msg)
    return downgraded


def _normalize_tool_call_id(id_: str, model: Model[Any], source: AssistantMessage) -> str:
    """Default normalization - override in specific providers."""
    return id_


def transform_messages(
    messages: list[Message],
    model: Model[Any],
    normalize_tool_call_id: Any = None,
) -> list[Message]:
    """
    Transform messages for cross-provider compatibility.

    Handles:
    - Unsupported image downgrade
    - Thinking block processing
    - Tool call ID normalization
    - Synthetic tool result insertion for orphaned calls
    """
    if normalize_tool_call_id is None:
        normalize_tool_call_id = _normalize_tool_call_id

    tool_call_id_map: dict[str, str] = {}
    image_aware_messages = _downgrade_unsupported_images(messages, model)

    # First pass: transform messages
    transformed: list[Message] = []
    for msg in image_aware_messages:
        # User messages pass through unchanged
        if msg["role"] == "user":
            transformed.append(msg)
            continue

        # Handle toolResult messages
        if msg["role"] == "toolResult":
            normalized_id = tool_call_id_map.get(msg["toolCallId"])
            if normalized_id and normalized_id != msg["toolCallId"]:
                transformed.append({**msg, "toolCallId": normalized_id})
            else:
                transformed.append(msg)
            continue

        # Assistant messages need transformation
        if msg["role"] == "assistant":
            assistant_msg: AssistantMessage = msg
            is_same_model = (
                assistant_msg.get("provider") == model.get("provider")
                and assistant_msg.get("api") == model.get("api")
                and assistant_msg.get("model") == model.get("id")
            )

            transformed_content = []
            for block in assistant_msg.get("content", []):
                if block["type"] == "thinking":
                    # Redacted thinking is opaque, only valid for same model
                    if block.get("redacted"):
                        if is_same_model:
                            transformed_content.append(block)
                        continue
                    # For same model: keep thinking blocks with signatures
                    if is_same_model and block.get("thinkingSignature"):
                        transformed_content.append(block)
                        continue
                    # Skip empty thinking blocks, convert others to plain text
                    if not block.get("thinking", "").strip():
                        continue
                    if is_same_model:
                        transformed_content.append(block)
                        continue
                    transformed_content.append({"type": "text", "text": block["thinking"]})
                    continue

                if block["type"] == "text":
                    if is_same_model:
                        transformed_content.append(block)
                    else:
                        transformed_content.append({"type": "text", "text": block["text"]})
                    continue

                if block["type"] == "toolCall":
                    tool_call: ToolCall = block
                    normalized_tool_call: ToolCall = tool_call.copy()

                    if not is_same_model and tool_call.get("thoughtSignature"):
                        normalized_tool_call = tool_call.copy()
                        normalized_tool_call.pop("thoughtSignature", None)

                    if not is_same_model:
                        normalized_id = normalize_tool_call_id(
                            tool_call["id"], model, assistant_msg
                        )
                        if normalized_id != tool_call["id"]:
                            tool_call_id_map[tool_call["id"]] = normalized_id
                            normalized_tool_call = normalized_tool_call.copy()
                            normalized_tool_call["id"] = normalized_id

                    transformed_content.append(normalized_tool_call)
                    continue

                transformed_content.append(block)

            transformed.append({**assistant_msg, "content": transformed_content})
            continue

        transformed.append(msg)

    # Second pass: insert synthetic tool results for orphaned calls
    result: list[Message] = []
    pending_tool_calls: list[ToolCall] = []
    existing_tool_result_ids: set[str] = set()

    def insert_synthetic_tool_results() -> None:
        nonlocal pending_tool_calls, existing_tool_result_ids
        if pending_tool_calls:
            for tc in pending_tool_calls:
                if tc["id"] not in existing_tool_result_ids:
                    result.append(
                        {
                            "role": "toolResult",
                            "toolCallId": tc["id"],
                            "toolName": tc["name"],
                            "content": [{"type": "text", "text": "No result provided"}],
                            "isError": True,
                            "timestamp": int(__import__("time").time() * 1000),
                        }
                    )
            pending_tool_calls = []
            existing_tool_result_ids = set()

    for msg in transformed:
        if msg["role"] == "assistant":
            insert_synthetic_tool_results()

            assistant_msg: AssistantMessage = msg
            if assistant_msg.get("stopReason") in ("error", "aborted"):
                continue

            tool_calls = [b for b in assistant_msg.get("content", []) if b["type"] == "toolCall"]
            if tool_calls:
                pending_tool_calls = tool_calls
                existing_tool_result_ids = set()

            result.append(msg)

        elif msg["role"] == "toolResult":
            existing_tool_result_ids.add(msg["toolCallId"])
            result.append(msg)

        elif msg["role"] == "user":
            insert_synthetic_tool_results()
            result.append(msg)

        else:
            result.append(msg)

    insert_synthetic_tool_results()
    return result
