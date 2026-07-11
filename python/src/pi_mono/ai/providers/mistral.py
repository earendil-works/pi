import asyncio
import json
import re
import time
from typing import Any, Callable, Dict, List, Optional, cast

import httpx
from mistralai.client import Mistral
from mistralai.client.types import UNSET

from pi_mono.ai.models import calculate_cost, clamp_thinking_level
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Message,
    Model,
    SimpleStreamOptions,
    StopReason,
    StreamOptions,
    Tool,
)
from pi_mono.utils.event_stream import AssistantMessageEventStream
from pi_mono.utils.hash import short_hash
from pi_mono.utils.json_parse import parse_streaming_json
from pi_mono.utils.node_http_proxy import create_http_proxy_agents_for_target
from pi_mono.utils.sanitize_unicode import sanitize_surrogates
from pi_mono.ai.providers.simple_options import build_base_options
from pi_mono.ai.providers.transform_messages import transform_messages

MISTRAL_TOOL_CALL_ID_LENGTH = 9
MAX_MISTRAL_ERROR_BODY_CHARS = 4000


class MistralOptions(StreamOptions, total=False):
    toolChoice: Any
    promptMode: str
    reasoningEffort: str


def safe_get(obj: Any, key: str, default: Any = None) -> Any:
    """Safely retrieves a key from a dictionary or an attribute from an object."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def create_output(model: Model) -> AssistantMessage:
    """Helper to create initial/partial AssistantMessage."""
    return {
        "role": "assistant",
        "content": [],
        "api": model.get("api", "mistral-conversations"),
        "provider": model.get("provider", "mistral"),
        "model": model["id"],
        "usage": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 0,
            "cost": {
                "input": 0.0,
                "output": 0.0,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
                "total": 0.0,
            },
        },
        "stopReason": "stop",
        "timestamp": int(time.time() * 1000),
    }


def create_mistral_tool_call_id_normalizer() -> Callable[[str], str]:
    """Factory creating normalizer to fit tool call IDs within Mistral length bounds."""
    id_map: Dict[str, str] = {}
    reverse_map: Dict[str, str] = {}

    def normalizer(id_val: str) -> str:
        existing = id_map.get(id_val)
        if existing:
            return existing

        attempt = 0
        while True:
            candidate = derive_mistral_tool_call_id(id_val, attempt)
            owner = reverse_map.get(candidate)
            if not owner or owner == id_val:
                id_map[id_val] = candidate
                reverse_map[candidate] = id_val
                return candidate
            attempt += 1

    return normalizer


def derive_mistral_tool_call_id(id_val: str, attempt: int) -> str:
    """Derives a base36 hash-derived ID matching Mistral's required format."""
    normalized = re.sub(r"[^a-zA-Z0-9]", "", id_val)
    if attempt == 0 and len(normalized) == MISTRAL_TOOL_CALL_ID_LENGTH:
        return normalized
    seed_base = normalized or id_val
    seed = seed_base if attempt == 0 else f"{seed_base}:{attempt}"
    hashed = short_hash(seed)
    return re.sub(r"[^a-zA-Z0-9]", "", hashed)[:MISTRAL_TOOL_CALL_ID_LENGTH]


def format_mistral_error(error: Any) -> str:
    """Formats SDKError and other standard errors into clean user messages."""
    if isinstance(error, Exception):
        status_code = None
        body_text = None
        if hasattr(error, "raw_response") and error.raw_response is not None:
            status_code = getattr(error.raw_response, "status_code", None)

        body = getattr(error, "body", None)
        if body is not None:
            if isinstance(body, str):
                body_text = body.strip()
            elif isinstance(body, bytes):
                body_text = body.decode("utf-8", errors="ignore").strip()

        if status_code is not None and body_text:
            return f"Mistral API error ({status_code}): {truncate_error_text(body_text, MAX_MISTRAL_ERROR_BODY_CHARS)}"
        if status_code is not None:
            msg = getattr(error, "message", None) or str(error)
            return f"Mistral API error ({status_code}): {msg}"

        return getattr(error, "message", None) or str(error)
    return safe_json_stringify(error)


def truncate_error_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}... [truncated {len(text) - max_chars} chars]"


def safe_json_stringify(value: Any) -> str:
    try:
        serialized = json.dumps(value)
        return str(value) if serialized is None else serialized
    except Exception:
        return str(value)


def should_use_prompt_caching(options: Optional[MistralOptions]) -> bool:
    options_dict = options or {}
    return options_dict.get("cacheRetention") != "none" and bool(options_dict.get("sessionId"))


def get_mistral_cached_prompt_tokens(usage: Any, prompt_tokens: int) -> int:
    raw_usage = usage if isinstance(usage, dict) else {}
    details = raw_usage.get("promptTokensDetails") or raw_usage.get("prompt_tokens_details") or {}
    alt_details = raw_usage.get("promptTokenDetails") or raw_usage.get("prompt_token_details") or {}
    raw_cached = (
        (details.get("cachedTokens") if isinstance(details, dict) else None)
        or (details.get("cached_tokens") if isinstance(details, dict) else None)
        or (alt_details.get("cachedTokens") if isinstance(alt_details, dict) else None)
        or (alt_details.get("cached_tokens") if isinstance(alt_details, dict) else None)
        or raw_usage.get("numCachedTokens")
        or raw_usage.get("num_cached_tokens")
        or 0
    )
    cached_tokens = raw_cached if isinstance(raw_cached, (int, float)) else 0
    cached_int = int(cached_tokens)
    return min(prompt_tokens, max(0, cached_int))


def build_request_options(model: Model, options: Optional[MistralOptions] = None) -> Dict[str, Any]:
    """Resolves affinity routing headers and custom timeouts for Mistral requests."""
    options_dict = options or {}
    headers: Dict[str, str] = {}
    if model.get("headers"):
        headers.update(model["headers"])
    if options_dict.get("headers"):
        headers.update(options_dict["headers"])

    if should_use_prompt_caching(options_dict) and "x-affinity" not in headers:
        headers["x-affinity"] = str(options_dict["sessionId"])

    res: Dict[str, Any] = {}
    if headers:
        res["http_headers"] = headers
    if options_dict.get("timeoutMs"):
        res["timeout_ms"] = options_dict["timeoutMs"]
    return res


def map_tool_choice(choice: Any) -> Any:
    """Translates tool choice settings to Mistral API formats."""
    if not choice:
        return None
    if choice in ("auto", "none", "any", "required"):
        return choice
    func_name = choice.get("function", {}).get("name") if isinstance(choice, dict) else None
    if func_name:
        return {
            "type": "function",
            "function": {"name": func_name},
        }
    return choice


def to_function_tools(tools: List[Tool]) -> List[Dict[str, Any]]:
    """Converts local Tool configurations into Mistral Function Tool structures."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.get("name"),
                "description": tool.get("description"),
                "parameters": strip_symbol_keys(tool.get("parameters")),
                "strict": False,
            },
        }
        for tool in tools
    ]


def strip_symbol_keys(value: Any) -> Any:
    if isinstance(value, list):
        return [strip_symbol_keys(item) for item in value]
    if isinstance(value, dict):
        return {k: strip_symbol_keys(v) for k, v in value.items()}
    return value


def build_tool_result_text(
    text: str, has_images: bool, supports_images: bool, is_error: bool
) -> str:
    trimmed = text.strip()
    error_prefix = "[tool error] " if is_error else ""

    if len(trimmed) > 0:
        image_suffix = (
            "\n[tool image omitted: model does not support images]"
            if has_images and not supports_images
            else ""
        )
        return f"{error_prefix}{trimmed}{image_suffix}"

    if has_images:
        if supports_images:
            return f"{error_prefix}(see attached image)"
        return f"{error_prefix}(image omitted: model does not support images)"

    return f"{error_prefix}(no tool output)"


def to_chat_messages(messages: List[Message], supports_images: bool) -> List[Dict[str, Any]]:
    """Maps custom history format to the official Mistral SDK Chat messages."""
    result: List[Dict[str, Any]] = []
    for msg_val in messages:
        msg = cast(Dict[str, Any], msg_val)
        role = msg.get("role")
        if role == "user":
            msg_content = msg.get("content")
            if isinstance(msg_content, str):
                result.append(
                    {
                        "role": "user",
                        "content": sanitize_surrogates(msg_content),
                    }
                )
                continue

            content_list = cast(List[Any], msg_content or [])
            had_images = any(
                isinstance(item, dict) and item.get("type") == "image" for item in content_list
            )
            content = []
            for item_val in content_list:
                item = cast(Dict[str, Any], item_val)
                item_type = item.get("type")
                if item_type == "text":
                    content.append(
                        {
                            "type": "text",
                            "text": sanitize_surrogates(item.get("text", "")),
                        }
                    )
                elif item_type == "image" and supports_images:
                    content.append(
                        {
                            "type": "image_url",
                            "image_url": f"data:{item.get('mimeType')};base64,{item.get('data')}",
                        }
                    )

            if content:
                result.append(
                    {
                        "role": "user",
                        "content": content,
                    }
                )
            elif had_images and not supports_images:
                result.append(
                    {
                        "role": "user",
                        "content": "(image omitted: model does not support images)",
                    }
                )
            continue

        if role == "assistant":
            content_parts: List[Dict[str, Any]] = []
            tool_calls: List[Dict[str, Any]] = []
            for block_val in msg.get("content", []):
                block = cast(Dict[str, Any], block_val)
                block_type = block.get("type")
                if block_type == "text":
                    text_val = block.get("text", "")
                    if text_val.strip():
                        content_parts.append(
                            {
                                "type": "text",
                                "text": sanitize_surrogates(text_val),
                            }
                        )
                elif block_type == "thinking":
                    thinking_val = block.get("thinking", "")
                    if thinking_val.strip():
                        content_parts.append(
                            {
                                "type": "thinking",
                                "thinking": [
                                    {"type": "text", "text": sanitize_surrogates(thinking_val)}
                                ],
                            }
                        )
                elif block_type == "toolCall":
                    tool_calls.append(
                        {
                            "id": block.get("id"),
                            "type": "function",
                            "function": {
                                "name": block.get("name"),
                                "arguments": json.dumps(block.get("arguments", {})),
                            },
                        }
                    )

            assistant_msg: Dict[str, Any] = {"role": "assistant"}
            if content_parts:
                assistant_msg["content"] = content_parts
            if tool_calls:
                assistant_msg["tool_calls"] = tool_calls
            if content_parts or tool_calls:
                result.append(assistant_msg)
            continue

        if role == "toolResult":
            tool_content = []
            text_result = ""
            for part_val in msg.get("content", []):
                part = cast(Dict[str, Any], part_val)
                if part.get("type") == "text":
                    text_result += part.get("text", "")

            has_images = any(
                isinstance(part, dict) and part.get("type") == "image"
                for part in msg.get("content", [])
            )
            tool_text = build_tool_result_text(
                text_result, has_images, supports_images, bool(msg.get("isError", False))
            )
            tool_content.append({"type": "text", "text": tool_text})

            for part_val in msg.get("content", []):
                part = cast(Dict[str, Any], part_val)
                if supports_images and part.get("type") == "image":
                    tool_content.append(
                        {
                            "type": "image_url",
                            "image_url": f"data:{part.get('mimeType')};base64,{part.get('data')}",
                        }
                    )

            result.append(
                {
                    "role": "tool",
                    "tool_call_id": msg.get("toolCallId"),
                    "name": msg.get("toolName"),
                    "content": tool_content,
                }
            )

    return result


def map_chat_stop_reason(reason: Any) -> StopReason:
    """Translates Mistral finish reason code to uniform StopReason."""
    reason_str = str(reason) if reason is not None else None
    if reason_str == "stop":
        return "stop"
    if reason_str in ("length", "model_length"):
        return "length"
    if reason_str == "tool_calls":
        return "toolUse"
    if reason_str == "error":
        return "error"
    return "stop"


def uses_reasoning_effort(model: Model) -> bool:
    model_id = model.get("id")
    return model_id in ("mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5")


def uses_prompt_mode_reasoning(model: Model) -> bool:
    return bool(model.get("reasoning")) and not uses_reasoning_effort(model)


def map_reasoning_effort(model: Model, level: str) -> str:
    thinking_level_map = cast(Dict[str, Any], model.get("thinkingLevelMap") or {})
    return thinking_level_map.get(level) or "high"


def build_chat_payload(
    model: Model,
    context: Context,
    messages: List[Message],
    options: Optional[MistralOptions] = None,
) -> Dict[str, Any]:
    options_dict = options or {}
    payload: Dict[str, Any] = {
        "model": model["id"],
        "messages": to_chat_messages(messages, "image" in model.get("input", [])),
    }

    if context.get("tools"):
        payload["tools"] = to_function_tools(context["tools"])
    if options_dict.get("temperature") is not None:
        payload["temperature"] = options_dict["temperature"]
    if options_dict.get("maxTokens") is not None:
        payload["max_tokens"] = options_dict["maxTokens"]
    if options_dict.get("toolChoice"):
        payload["tool_choice"] = map_tool_choice(options_dict["toolChoice"])
    if options_dict.get("promptMode"):
        payload["prompt_mode"] = options_dict["promptMode"]
    if options_dict.get("reasoningEffort"):
        payload["reasoning_effort"] = options_dict["reasoningEffort"]
    if should_use_prompt_caching(options_dict):
        payload["prompt_cache_key"] = options_dict.get("sessionId")

    system_prompt = context.get("systemPrompt")
    if system_prompt:
        payload["messages"].insert(
            0,
            {
                "role": "system",
                "content": sanitize_surrogates(system_prompt),
            },
        )

    return payload


async def consume_chat_stream(
    model: Model,
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    mistral_stream: Any,
    signal: Optional[Any] = None,
) -> None:
    """Consumes the speakeasy event stream and yields standardized events."""
    output_dict = cast(Dict[str, Any], output)
    current_block: Optional[Dict[str, Any]] = None
    blocks = output_dict["content"]

    def block_index() -> int:
        return len(blocks) - 1

    tool_blocks_by_key: Dict[str, int] = {}

    def finish_current_block(block: Optional[Dict[str, Any]] = None) -> None:
        if not block:
            return
        if block.get("type") == "text":
            stream.push(
                {
                    "type": "text_end",
                    "contentIndex": block_index(),
                    "content": block.get("text", ""),
                    "partial": output,
                }
            )
        elif block.get("type") == "thinking":
            stream.push(
                {
                    "type": "thinking_end",
                    "contentIndex": block_index(),
                    "content": block.get("thinking", ""),
                    "partial": output,
                }
            )

    async for event in mistral_stream:
        if signal and getattr(signal, "aborted", False):
            output_dict["stopReason"] = "aborted"
            break

        chunk = event.data
        chunk_id = safe_get(chunk, "id")
        if chunk_id:
            output_dict["responseId"] = chunk_id

        usage = safe_get(chunk, "usage")
        if usage:
            prompt_tokens = safe_get(usage, "prompt_tokens") or 0
            output_dict["usage"]["input"] = prompt_tokens
            output_dict["usage"]["output"] = safe_get(usage, "completion_tokens") or 0
            output_dict["usage"]["cacheRead"] = get_mistral_cached_prompt_tokens(
                usage, prompt_tokens
            )
            output_dict["usage"]["cacheWrite"] = 0
            output_dict["usage"]["totalTokens"] = safe_get(usage, "total_tokens") or (
                output_dict["usage"]["input"] + output_dict["usage"]["output"]
            )
            calculate_cost(model, output_dict["usage"])

        choices = safe_get(chunk, "choices")
        if not choices:
            continue
        choice = choices[0]

        finish_reason = safe_get(choice, "finish_reason")
        if finish_reason:
            output_dict["stopReason"] = map_chat_stop_reason(finish_reason)

        delta = safe_get(choice, "delta")
        if delta is not None:
            delta_content = safe_get(delta, "content")
            if delta_content is not None:
                content_items = [delta_content] if isinstance(delta_content, str) else delta_content
                for item_val in content_items:
                    if isinstance(item_val, str):
                        text_delta = sanitize_surrogates(item_val)
                        if not current_block or current_block.get("type") != "text":
                            finish_current_block(current_block)
                            current_block = {"type": "text", "text": ""}
                            blocks.append(current_block)
                            stream.push(
                                {
                                    "type": "text_start",
                                    "contentIndex": block_index(),
                                    "partial": output,
                                }
                            )
                        current_block["text"] = current_block.get("text", "") + text_delta
                        stream.push(
                            {
                                "type": "text_delta",
                                "contentIndex": block_index(),
                                "delta": text_delta,
                                "partial": output,
                            }
                        )
                        continue

                    item = cast(Dict[str, Any], item_val)
                    item_type = safe_get(item, "type")
                    if item_type == "thinking":
                        thinking_parts = safe_get(item, "thinking", [])
                        delta_text = ""
                        for part in thinking_parts:
                            part_text = (
                                safe_get(part, "text", "") if not isinstance(part, str) else part
                            )
                            if part_text:
                                delta_text += part_text
                        thinking_delta = sanitize_surrogates(delta_text)
                        if not thinking_delta:
                            continue
                        if not current_block or current_block.get("type") != "thinking":
                            finish_current_block(current_block)
                            current_block = {"type": "thinking", "thinking": ""}
                            blocks.append(current_block)
                            stream.push(
                                {
                                    "type": "thinking_start",
                                    "contentIndex": block_index(),
                                    "partial": output,
                                }
                            )
                        current_block["thinking"] = (
                            current_block.get("thinking", "") + thinking_delta
                        )
                        stream.push(
                            {
                                "type": "thinking_delta",
                                "contentIndex": block_index(),
                                "delta": thinking_delta,
                                "partial": output,
                            }
                        )
                        continue

                    if item_type == "text":
                        text_delta = sanitize_surrogates(safe_get(item, "text", ""))
                        if not current_block or current_block.get("type") != "text":
                            finish_current_block(current_block)
                            current_block = {"type": "text", "text": ""}
                            blocks.append(current_block)
                            stream.push(
                                {
                                    "type": "text_start",
                                    "contentIndex": block_index(),
                                    "partial": output,
                                }
                            )
                        current_block["text"] = current_block.get("text", "") + text_delta
                        stream.push(
                            {
                                "type": "text_delta",
                                "contentIndex": block_index(),
                                "delta": text_delta,
                                "partial": output,
                            }
                        )

            tool_calls = safe_get(delta, "tool_calls") or []
            for tool_call in tool_calls:
                if current_block:
                    finish_current_block(current_block)
                    current_block = None

                tc_id = safe_get(tool_call, "id")
                tc_index = safe_get(tool_call, "index") or 0
                tc_function = safe_get(tool_call, "function")
                tc_func_name = safe_get(tc_function, "name") if tc_function else ""

                call_id = (
                    tc_id
                    if tc_id and tc_id != "null"
                    else derive_mistral_tool_call_id(f"toolcall:{tc_index}", 0)
                )
                key = f"{call_id}:{tc_index}"
                existing_index = tool_blocks_by_key.get(key)
                block = None

                if existing_index is not None:
                    existing = blocks[existing_index]
                    if existing.get("type") == "toolCall":
                        block = existing

                if not block:
                    block = {
                        "type": "toolCall",
                        "id": call_id,
                        "name": tc_func_name,
                        "arguments": {},
                        "partialArgs": "",
                    }
                    blocks.append(block)
                    tool_blocks_by_key[key] = len(blocks) - 1
                    stream.push(
                        {
                            "type": "toolcall_start",
                            "contentIndex": len(blocks) - 1,
                            "partial": output,
                        }
                    )

                tc_args = safe_get(tc_function, "arguments") if tc_function else ""
                args_delta = tc_args if isinstance(tc_args, str) else json.dumps(tc_args or {})
                block["partialArgs"] = block.get("partialArgs", "") + args_delta
                block["arguments"] = parse_streaming_json(block["partialArgs"])
                stream.push(
                    {
                        "type": "toolcall_delta",
                        "contentIndex": tool_blocks_by_key[key],
                        "delta": args_delta,
                        "partial": output,
                    }
                )

    finish_current_block(current_block)
    for index in tool_blocks_by_key.values():
        block = blocks[index]
        if block.get("type") != "toolCall":
            continue
        block["arguments"] = parse_streaming_json(block.get("partialArgs", ""))
        block.pop("partialArgs", None)
        stream.push(
            {
                "type": "toolcall_end",
                "contentIndex": index,
                "toolCall": cast(Any, block),
                "partial": output,
            }
        )


def stream_mistral(
    model: Model,
    context: Context,
    options: Optional[MistralOptions] = None,
) -> AssistantMessageEventStream:
    """Stream responses from Mistral using stream_async."""
    stream = AssistantMessageEventStream()

    async def run_async_stream():
        output = create_output(model)
        http_client = None
        try:
            options_dict = options or {}
            api_key = options_dict.get("apiKey")
            if not api_key:
                raise ValueError(f"No API key for provider: {model.get('provider')}")

            proxy_config = create_http_proxy_agents_for_target(
                model.get("baseUrl") or "https://api.mistral.ai"
            )
            if proxy_config:
                proxy_url = proxy_config.get("https") or proxy_config.get("http")
                http_client = httpx.AsyncClient(proxy=proxy_url)
            else:
                http_client = None

            mistral = Mistral(
                api_key=api_key,
                server_url=model.get("baseUrl"),
                async_client=http_client,
            )

            normalize_mistral_tool_call_id = create_mistral_tool_call_id_normalizer()
            transformed = transform_messages(
                context.get("messages", []),
                model,
                lambda id_val, _m, _s: normalize_mistral_tool_call_id(id_val),
            )

            payload = build_chat_payload(model, context, transformed, options_dict)
            on_payload = options_dict.get("onPayload")
            if on_payload and callable(on_payload):
                next_payload = await on_payload(payload, model)
                if next_payload is not None:
                    payload = next_payload

            req_options = build_request_options(model, options_dict)

            mistral_stream = await mistral.chat.stream_async(
                model=payload["model"],
                messages=payload["messages"],
                temperature=payload.get("temperature", UNSET),
                max_tokens=payload.get("max_tokens", UNSET),
                tools=payload.get("tools", UNSET),
                tool_choice=payload.get("tool_choice", None),
                prompt_mode=payload.get("prompt_mode", UNSET),
                reasoning_effort=payload.get("reasoning_effort", UNSET),
                timeout_ms=req_options.get("timeout_ms"),
                http_headers=req_options.get("http_headers"),
            )

            stream.push({"type": "start", "partial": output})

            await consume_chat_stream(
                model, output, stream, mistral_stream, options_dict.get("signal")
            )

            signal = options_dict.get("signal")
            if signal and getattr(signal, "aborted", False):
                raise ValueError("Request was aborted")

            if output.get("stopReason") in ("aborted", "error"):
                raise ValueError("An unknown error occurred")

            stream.push(
                {
                    "type": "done",
                    "reason": output.get("stopReason", "stop"),
                    "message": output,
                }
            )
            stream.end()
        except Exception as error:
            for block in output.get("content", []):
                if "partialArgs" in block:
                    block.pop("partialArgs", None)

            signal = options_dict.get("signal") if options else None
            output["stopReason"] = (
                "aborted" if (signal and getattr(signal, "aborted", False)) else "error"
            )
            output["errorMessage"] = format_mistral_error(error)
            stream.push({"type": "error", "reason": output["stopReason"], "error": output})
            stream.end()
        finally:
            if http_client:
                await http_client.aclose()

    asyncio.get_running_loop().create_task(run_async_stream())
    return stream


def stream_simple_mistral(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessageEventStream:
    """Maps simple stream options to Mistral-specific settings and starts streaming."""
    options_dict = options or {}
    api_key = options_dict.get("apiKey")
    if not api_key:
        raise ValueError(f"No API key for provider: {model.get('provider')}")

    base = build_base_options(model, context, options_dict, api_key)

    reasoning_opt = options_dict.get("reasoning")
    clamped_reasoning = (
        clamp_thinking_level(model, cast(Any, reasoning_opt)) if reasoning_opt else None
    )
    reasoning = None if clamped_reasoning == "off" else clamped_reasoning

    should_use_reasoning = bool(model.get("reasoning")) and reasoning is not None

    mistral_opts = cast(MistralOptions, dict(base))
    if should_use_reasoning and uses_prompt_mode_reasoning(model):
        mistral_opts["promptMode"] = "reasoning"
    if should_use_reasoning and uses_reasoning_effort(model) and reasoning is not None:
        mistral_opts["reasoningEffort"] = map_reasoning_effort(model, reasoning)

    return stream_mistral(model, context, mistral_opts)
