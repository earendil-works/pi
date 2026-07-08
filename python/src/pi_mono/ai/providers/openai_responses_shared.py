"""OpenAI Responses API shared utilities."""

import json
import re
from typing import Any

from pi_mono.ai.models import calculate_cost
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    StopReason,
    TextContent,
    ThinkingContent,
    Tool,
    ToolCall,
)
from pi_mono.ai.utils.event_stream import AssistantMessageEventStream
from pi_mono.ai.utils.hash import short_hash
from pi_mono.ai.utils.json_parse import parse_streaming_json
from pi_mono.ai.utils.sanitize_unicode import sanitize_surrogates
from pi_mono.ai.providers.transform_messages import transform_messages


def encode_text_signature_v1(id_: str, phase: str | None = None) -> str:
    """Encode text signature v1."""
    payload: dict[str, Any] = {"v": 1, "id": id_}
    if phase:
        payload["phase"] = phase
    return json.dumps(payload)


def parse_text_signature(signature: str | None) -> dict[str, str] | None:
    if not signature:
        return None
    if signature.startswith("{"):
        try:
            parsed = json.loads(signature)
            if parsed.get("v") == 1 and isinstance(parsed.get("id"), str):
                if parsed.get("phase") in ("commentary", "final_answer"):
                    return {"id": parsed["id"], "phase": parsed["phase"]}
                return {"id": parsed["id"]}
        except json.JSONDecodeError:
            pass
    return {"id": signature}


class OpenAIResponsesStreamOptions:
    def __init__(
        self,
        service_tier: str | None = None,
        resolve_service_tier: Any = None,
        apply_service_tier_pricing: Any = None,
    ):
        self.service_tier = service_tier
        self.resolve_service_tier = resolve_service_tier
        self.apply_service_tier_pricing = apply_service_tier_pricing


class ConvertResponsesMessagesOptions:
    def __init__(self, include_system_prompt: bool = True):
        self.include_system_prompt = include_system_prompt


class ConvertResponsesToolsOptions:
    def __init__(self, strict: bool | None = False):
        self.strict = strict


def _normalize_id_part(part: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", part)
    normalized = sanitized[:64] if len(sanitized) > 64 else sanitized
    return normalized.rstrip("_")


def _build_foreign_responses_item_id(item_id: str) -> str:
    normalized = f"fc_{short_hash(item_id)}"
    return normalized[:64] if len(normalized) > 64 else normalized


def _normalize_tool_call_id(
    id_: str, model: Model[Any], source: AssistantMessage, allowed_providers: set[str]
) -> str:
    if model.provider not in allowed_providers:
        return _normalize_id_part(id_)
    if "|" not in id_:
        return _normalize_id_part(id_)
    call_id, item_id = id_.split("|", 1)
    normalized_call_id = _normalize_id_part(call_id)
    is_foreign_tool_call = source.provider != model.provider or source.api != model.api
    normalized_item_id = (
        _build_foreign_responses_item_id(item_id)
        if is_foreign_tool_call
        else _normalize_id_part(item_id)
    )
    if not normalized_item_id.startswith("fc_"):
        normalized_item_id = _normalize_id_part(f"fc_{normalized_item_id}")
    return f"{normalized_call_id}|{normalized_item_id}"


def convert_responses_messages(
    model: Model[Any],
    context: Context,
    allowed_tool_call_providers: set[str],
    options: ConvertResponsesMessagesOptions | None = None,
) -> list[dict[str, Any]]:
    """Convert messages to OpenAI Responses API format."""
    messages: list[dict[str, Any]] = []

    transformed_messages = transform_messages(
        context["messages"],
        model,
        lambda id_, m, s: _normalize_tool_call_id(id_, model, m, allowed_tool_call_providers),
    )

    include_system_prompt = options.include_system_prompt if options else True
    if include_system_prompt and context.get("systemPrompt"):
        role = "developer" if model.get("reasoning") else "system"
        messages.append(
            {
                "role": role,
                "content": sanitize_surrogates(context["systemPrompt"]),
            }
        )

    msg_index = 0
    for msg in transformed_messages:
        if msg["role"] == "user":
            if isinstance(msg["content"], str):
                messages.append(
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": sanitize_surrogates(msg["content"])}
                        ],
                    }
                )
            else:
                content = []
                for item in msg["content"]:
                    if item["type"] == "text":
                        content.append(
                            {"type": "input_text", "text": sanitize_surrogates(item["text"])}
                        )
                    else:
                        content.append(
                            {
                                "type": "input_image",
                                "detail": "auto",
                                "image_url": f"data:{item['mimeType']};base64,{item['data']}",
                            }
                        )
                if content:
                    messages.append({"role": "user", "content": content})

        elif msg["role"] == "assistant":
            output: list[dict[str, Any]] = []
            assistant_msg = msg
            is_different_model = (
                assistant_msg.get("model") != model["id"]
                and assistant_msg.get("provider") == model["provider"]
                and assistant_msg.get("api") == model["api"]
            )
            text_block_index = 0

            for block in assistant_msg.get("content", []):
                if block["type"] == "thinking":
                    if block.get("thinkingSignature"):
                        try:
                            reasoning_item = json.loads(block["thinkingSignature"])
                            output.append(reasoning_item)
                        except json.JSONDecodeError:
                            pass
                elif block["type"] == "text":
                    text_block: TextContent = block
                    parsed_signature = parse_text_signature(text_block.get("textSignature"))
                    fallback_message_id = (
                        f"msg_pi_{msg_index}"
                        if text_block_index == 0
                        else f"msg_pi_{msg_index}_{text_block_index}"
                    )
                    text_block_index += 1

                    msg_id = parsed_signature.get("id") if parsed_signature else None
                    if not msg_id:
                        msg_id = fallback_message_id
                    elif len(msg_id) > 64:
                        msg_id = f"msg_{short_hash(msg_id)}"

                    output.append(
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": sanitize_surrogates(text_block["text"]),
                                    "annotations": [],
                                }
                            ],
                            "status": "completed",
                            "id": msg_id,
                            "phase": parsed_signature.get("phase") if parsed_signature else None,
                        }
                    )
                elif block["type"] == "toolCall":
                    tool_call: ToolCall = block
                    call_id, item_id_raw = tool_call["id"].split("|", 1)
                    item_id: str | None = item_id_raw

                    if is_different_model and item_id and item_id.startswith("fc_"):
                        item_id = None

                    output.append(
                        {
                            "type": "function_call",
                            "id": item_id,
                            "call_id": call_id,
                            "name": tool_call["name"],
                            "arguments": json.dumps(tool_call["arguments"]),
                        }
                    )

            if output:
                messages.extend(output)

        elif msg["role"] == "toolResult":
            text_result = "\n".join(c["text"] for c in msg["content"] if c["type"] == "text")
            has_images = any(c["type"] == "image" for c in msg["content"])
            has_text = len(text_result) > 0
            call_id = msg["toolCallId"].split("|", 1)[0]

            if has_images and "image" in model.get("input", []):
                content_parts = []
                if has_text:
                    content_parts.append(
                        {"type": "input_text", "text": sanitize_surrogates(text_result)}
                    )
                for block in msg["content"]:
                    if block["type"] == "image":
                        content_parts.append(
                            {
                                "type": "input_image",
                                "detail": "auto",
                                "image_url": f"data:{block['mimeType']};base64,{block['data']}",
                            }
                        )
                output = content_parts
            else:
                output = sanitize_surrogates(text_result if has_text else "(see attached image)")

            messages.append(
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }
            )

        msg_index += 1

    return messages


def convert_responses_tools(
    tools: list[Tool], options: ConvertResponsesToolsOptions | None = None
) -> list[dict[str, Any]]:
    strict = options.strict if options else False
    return [
        {
            "type": "function",
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool["parameters"],
            "strict": strict,
        }
        for tool in tools
    ]


async def process_responses_stream(
    openai_stream: Any,
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    model: Model[Any],
    options: OpenAIResponsesStreamOptions | None = None,
) -> None:
    """Process OpenAI Responses API streaming events."""
    current_item: dict[str, Any] | None = None
    current_block: ThinkingContent | TextContent | ToolCall | dict[str, Any] | None = None
    blocks = output["content"]

    def block_index() -> int:
        return len(blocks) - 1

    async for event in openai_stream:
        event_type = event.get("type")

        if event_type == "response.created":
            output["responseId"] = event["response"]["id"]

        elif event_type == "response.output_item.added":
            item = event["item"]
            if item["type"] == "reasoning":
                current_item = item
                current_block = {"type": "thinking", "thinking": "", "thinkingSignature": ""}
                blocks.append(current_block)
                stream.push(
                    {"type": "thinking_start", "contentIndex": block_index(), "partial": output}
                )
            elif item["type"] == "message":
                current_item = item
                current_block = {"type": "text", "text": "", "textSignature": ""}
                blocks.append(current_block)
                stream.push(
                    {"type": "text_start", "contentIndex": block_index(), "partial": output}
                )
            elif item["type"] == "function_call":
                current_item = item
                current_block = {
                    "type": "toolCall",
                    "id": f"{item['call_id']}|{item['id']}",
                    "name": item["name"],
                    "arguments": {},
                    "partialJson": item.get("arguments", ""),
                }
                blocks.append(current_block)
                stream.push(
                    {"type": "toolcall_start", "contentIndex": block_index(), "partial": output}
                )

        elif event_type == "response.reasoning_summary_part.added":
            if current_item and current_item["type"] == "reasoning":
                current_item.setdefault("summary", []).append(event["part"])

        elif event_type == "response.reasoning_summary_text.delta":
            if (
                current_item
                and current_item["type"] == "reasoning"
                and current_block
                and current_block["type"] == "thinking"
            ):
                summary = current_item.get("summary", [])
                last_part = summary[-1] if summary else None
                if last_part:
                    current_block["thinking"] += event["delta"]
                    last_part["text"] += event["delta"]
                    stream.push(
                        {
                            "type": "thinking_delta",
                            "contentIndex": block_index(),
                            "delta": event["delta"],
                            "partial": output,
                        }
                    )

        elif event_type == "response.reasoning_summary_part.done":
            if (
                current_item
                and current_item["type"] == "reasoning"
                and current_block
                and current_block["type"] == "thinking"
            ):
                summary = current_item.get("summary", [])
                last_part = summary[-1] if summary else None
                if last_part:
                    current_block["thinking"] += "\n\n"
                    last_part["text"] += "\n\n"
                    stream.push(
                        {
                            "type": "thinking_delta",
                            "contentIndex": block_index(),
                            "delta": "\n\n",
                            "partial": output,
                        }
                    )

        elif event_type == "response.reasoning_text.delta":
            if (
                current_item
                and current_item["type"] == "reasoning"
                and current_block
                and current_block["type"] == "thinking"
            ):
                current_block["thinking"] += event["delta"]
                stream.push(
                    {
                        "type": "thinking_delta",
                        "contentIndex": block_index(),
                        "delta": event["delta"],
                        "partial": output,
                    }
                )

        elif event_type == "response.content_part.added":
            if current_item and current_item["type"] == "message":
                current_item.setdefault("content", [])
                if event["part"]["type"] in ("output_text", "refusal"):
                    current_item["content"].append(event["part"])

        elif event_type == "response.output_text.delta":
            if (
                current_item
                and current_item["type"] == "message"
                and current_block
                and current_block["type"] == "text"
            ):
                content = current_item.get("content", [])
                if not content:
                    continue
                last_part = content[-1]
                if last_part.get("type") == "output_text":
                    current_block["text"] += event["delta"]
                    last_part["text"] += event["delta"]
                    stream.push(
                        {
                            "type": "text_delta",
                            "contentIndex": block_index(),
                            "delta": event["delta"],
                            "partial": output,
                        }
                    )

        elif event_type == "response.refusal.delta":
            if (
                current_item
                and current_item["type"] == "message"
                and current_block
                and current_block["type"] == "text"
            ):
                content = current_item.get("content", [])
                if not content:
                    continue
                last_part = content[-1]
                if last_part.get("type") == "refusal":
                    current_block["text"] += event["delta"]
                    last_part["refusal"] += event["delta"]
                    stream.push(
                        {
                            "type": "text_delta",
                            "contentIndex": block_index(),
                            "delta": event["delta"],
                            "partial": output,
                        }
                    )

        elif event_type == "response.function_call_arguments.delta":
            if (
                current_item
                and current_item["type"] == "function_call"
                and current_block
                and current_block["type"] == "toolCall"
            ):
                current_block["partialJson"] += event["delta"]
                current_block["arguments"] = parse_streaming_json(current_block["partialJson"])
                stream.push(
                    {
                        "type": "toolcall_delta",
                        "contentIndex": block_index(),
                        "delta": event["delta"],
                        "partial": output,
                    }
                )

        elif event_type == "response.function_call_arguments.done":
            if (
                current_item
                and current_item["type"] == "function_call"
                and current_block
                and current_block["type"] == "toolCall"
            ):
                previous_partial_json = current_block.get("partialJson", "")
                current_block["partialJson"] = event.get("arguments", "")
                current_block["arguments"] = parse_streaming_json(current_block["partialJson"])

                if current_block["partialJson"].startswith(previous_partial_json):
                    delta = current_block["partialJson"][len(previous_partial_json) :]
                    if delta:
                        stream.push(
                            {
                                "type": "toolcall_delta",
                                "contentIndex": block_index(),
                                "delta": delta,
                                "partial": output,
                            }
                        )

        elif event_type == "response.output_item.done":
            item = event["item"]

            if (
                item["type"] == "reasoning"
                and current_block
                and current_block["type"] == "thinking"
            ):
                summary_text = "\n\n".join(s.get("text", "") for s in item.get("summary", []))
                content_text = "\n\n".join(c.get("text", "") for c in item.get("content", []))
                current_block["thinking"] = (
                    summary_text or content_text or current_block["thinking"]
                )
                current_block["thinkingSignature"] = json.dumps(item)
                stream.push(
                    {
                        "type": "thinking_end",
                        "contentIndex": block_index(),
                        "content": current_block["thinking"],
                        "partial": output,
                    }
                )
                current_block = None

            elif item["type"] == "message" and current_block and current_block["type"] == "text":
                content_text = "".join(
                    c.get("text", "") if c.get("type") == "output_text" else c.get("refusal", "")
                    for c in item.get("content", [])
                )
                current_block["text"] = content_text
                current_block["textSignature"] = encode_text_signature_v1(
                    item["id"], item.get("phase")
                )
                stream.push(
                    {
                        "type": "text_end",
                        "contentIndex": block_index(),
                        "content": current_block["text"],
                        "partial": output,
                    }
                )
                current_block = None

            elif item["type"] == "function_call":
                args = (
                    parse_streaming_json(current_block.get("partialJson", ""))
                    if current_block
                    and current_block["type"] == "toolCall"
                    and current_block.get("partialJson")
                    else parse_streaming_json(item.get("arguments", "{}"))
                )

                tool_call: ToolCall
                if current_block and current_block["type"] == "toolCall":
                    current_block["arguments"] = args
                    current_block.pop("partialJson", None)
                    tool_call = current_block
                else:
                    tool_call = {
                        "type": "toolCall",
                        "id": f"{item['call_id']}|{item['id']}",
                        "name": item["name"],
                        "arguments": args,
                    }

                current_block = None
                stream.push(
                    {
                        "type": "toolcall_end",
                        "contentIndex": block_index(),
                        "toolCall": tool_call,
                        "partial": output,
                    }
                )

        elif event_type == "response.completed":
            response = event.get("response", {})
            if response.get("id"):
                output["responseId"] = response["id"]
            if response.get("usage"):
                cached_tokens = (
                    response["usage"].get("input_tokens_details", {}).get("cached_tokens", 0)
                )
                output["usage"] = {
                    "input": (response["usage"].get("input_tokens", 0) or 0) - cached_tokens,
                    "output": response["usage"].get("output_tokens", 0) or 0,
                    "cacheRead": cached_tokens,
                    "cacheWrite": 0,
                    "totalTokens": response["usage"].get("total_tokens", 0) or 0,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
                }
            calculate_cost(model, output["usage"])
            if options and options.apply_service_tier_pricing:
                service_tier = response.get("service_tier")
                if options.resolve_service_tier:
                    service_tier = options.resolve_service_tier(
                        response.get("service_tier"), options.service_tier
                    )
                options.apply_service_tier_pricing(output["usage"], service_tier)

            output["stopReason"] = map_stop_reason(response.get("status"))
            if (
                any(b["type"] == "toolCall" for b in output["content"])
                and output["stopReason"] == "stop"
            ):
                output["stopReason"] = "toolUse"

        elif event_type == "error":
            raise RuntimeError(
                f"Error Code {event.get('code', 'unknown')}: {event.get('message', 'Unknown error')}"
            )

        elif event_type == "response.failed":
            error = event.get("response", {}).get("error")
            details = event.get("response", {}).get("incomplete_details")
            if error:
                msg = f"{error.get('code', 'unknown')}: {error.get('message', 'no message')}"
            elif details and details.get("reason"):
                msg = f"incomplete: {details['reason']}"
            else:
                msg = "Unknown error (no error details in response)"
            raise RuntimeError(msg)


def map_stop_reason(status: str | None) -> StopReason:
    if not status:
        return "stop"
    if status == "completed":
        return "stop"
    if status == "incomplete":
        return "length"
    if status in ("failed", "cancelled"):
        return "error"
    if status in ("in_progress", "queued"):
        return "stop"
    raise RuntimeError(f"Unhandled stop reason: {status}")
