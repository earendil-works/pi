import asyncio
import json
import re
import time
from typing import Any, Dict, List, Literal, Optional, TypedDict, Union, cast

import httpx
from openai import AsyncOpenAI

from pi_mono.ai.models import calculate_cost, clamp_thinking_level
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    ModelThinkingLevel,
    SimpleStreamOptions,
    StreamOptions,
    TextContent,
    ThinkingContent,
    Tool,
    ToolCall,
    Usage,
)
from pi_mono.utils.event_stream import AssistantMessageEventStream
from pi_mono.utils.headers import headers_to_record
from pi_mono.utils.json_parse import parse_streaming_json
from pi_mono.utils.sanitize_unicode import sanitize_surrogates
from pi_mono.ai.providers.cloudflare import is_cloudflare_provider, resolve_cloudflare_base_url
from pi_mono.ai.providers.github_copilot_headers import (
    build_copilot_dynamic_headers,
    has_copilot_vision_input,
)
from pi_mono.ai.providers.simple_options import build_base_options
from pi_mono.ai.providers.transform_messages import transform_messages
from pi_mono.utils.node_http_proxy import create_http_proxy_agents_for_target

OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64

# Body fields accepted by the OpenAI Python SDK chat.completions.create().
# Provider-specific extensions (e.g. OpenRouter "reasoning") go in extra_body.
_OPENAI_CHAT_COMPLETION_SDK_BODY_KEYS = frozenset(
    {
        "messages",
        "model",
        "audio",
        "frequency_penalty",
        "function_call",
        "functions",
        "logit_bias",
        "logprobs",
        "max_completion_tokens",
        "max_tokens",
        "metadata",
        "modalities",
        "n",
        "parallel_tool_calls",
        "prediction",
        "presence_penalty",
        "prompt_cache_key",
        "prompt_cache_retention",
        "reasoning_effort",
        "response_format",
        "safety_identifier",
        "seed",
        "service_tier",
        "stop",
        "store",
        "stream",
        "stream_options",
        "temperature",
        "tool_choice",
        "tools",
        "top_logprobs",
        "top_p",
        "user",
        "verbosity",
        "web_search_options",
    }
)


def prepare_openai_chat_completion_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """Split provider extension fields into extra_body for the OpenAI Python SDK."""
    extra_body = dict(params.get("extra_body") or {})
    sdk_params: Dict[str, Any] = {}
    for key, value in params.items():
        if key == "extra_body":
            continue
        if key in _OPENAI_CHAT_COMPLETION_SDK_BODY_KEYS:
            sdk_params[key] = value
        else:
            extra_body[key] = value
    if extra_body:
        sdk_params["extra_body"] = extra_body
    return sdk_params


class OpenAICompletionsOptions(StreamOptions, total=False):
    toolChoice: Union[Literal["auto", "none", "required"], Dict[str, Any]]
    reasoningEffort: Literal["minimal", "low", "medium", "high", "xhigh"]


class OpenAICompatCacheControl(TypedDict, total=False):
    type: Literal["ephemeral"]
    ttl: str


def has_tool_history(messages: List[Any]) -> bool:
    for msg in messages:
        if msg.get("role") == "toolResult":
            return True
        if msg.get("role") == "assistant":
            content = msg.get("content")
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "toolCall":
                        return True
    return False


def is_text_content_block(block: Dict[str, Any]) -> bool:
    return block.get("type") == "text"


def is_thinking_content_block(block: Dict[str, Any]) -> bool:
    return block.get("type") == "thinking"


def is_tool_call_block(block: Dict[str, Any]) -> bool:
    return block.get("type") == "toolCall"


def is_image_content_block(block: Dict[str, Any]) -> bool:
    return block.get("type") == "image"


def resolve_cache_retention(cache_retention: Optional[str] = None) -> str:
    if cache_retention:
        return cache_retention
    import os

    if os.environ.get("PI_CACHE_RETENTION") == "long":
        return "long"
    return "short"


def clamp_openai_prompt_cache_key(key: Optional[str]) -> Optional[str]:
    if key is None:
        return None
    chars = list(key)
    if len(chars) <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH:
        return key
    return "".join(chars[:OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH])


def stream_openai_completions(
    model: Model,
    context: Context,
    options: Optional[OpenAICompletionsOptions] = None,
) -> AssistantMessageEventStream:
    event_stream = AssistantMessageEventStream()

    async def run() -> None:
        output: AssistantMessage = {
            "role": "assistant",
            "content": [],
            "api": model.get("api", "openai-completions"),
            "provider": model.get("provider", "openai"),
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

        try:
            options_dict: Dict[str, Any] = cast(Dict[str, Any], options or {})
            api_key = options_dict.get("apiKey")
            if not api_key:
                raise ValueError(f"No API key for provider: {model.get('provider')}")

            compat = get_compat(model)
            cache_retention = resolve_cache_retention(options_dict.get("cacheRetention"))
            cache_session_id = options_dict.get("sessionId") if cache_retention != "none" else None

            client = create_client(
                model,
                context,
                api_key,
                options_dict.get("headers"),
                cache_session_id,
                compat,
                options_dict.get("maxRetries", 0),
            )
            params = build_params(model, context, options, compat, cache_retention)

            on_payload = options_dict.get("onPayload")
            if on_payload:
                res = on_payload(params, model)
                if asyncio.iscoroutine(res):
                    res = await res
                if res is not None:
                    params = res

            timeout = (
                httpx.Timeout(options_dict["timeoutMs"] / 1000.0)
                if "timeoutMs" in options_dict
                else None
            )

            request_options: Dict[str, Any] = {}
            if timeout is not None:
                request_options["timeout"] = timeout

            raw_response = await client.chat.completions.with_raw_response.create(
                **prepare_openai_chat_completion_params(params),
                **request_options,
            )
            openai_stream = raw_response.parse()

            on_response = options_dict.get("onResponse")
            if on_response:
                res = on_response(
                    {
                        "status": raw_response.status_code,
                        "headers": headers_to_record(raw_response.headers),
                    },
                    model,
                )
                if asyncio.iscoroutine(res):
                    await res

            event_stream.push({"type": "start", "partial": output})

            text_block: Optional[TextContent] = None
            thinking_block: Optional[ThinkingContent] = None
            has_finish_reason = False
            tool_call_blocks_by_index: Dict[int, Dict[str, Any]] = {}
            tool_call_blocks_by_id: Dict[str, Dict[str, Any]] = {}
            blocks = output["content"]

            def get_content_index(block: Any) -> int:
                try:
                    return blocks.index(cast(Any, block))
                except ValueError:
                    return -1

            def finish_block(block: Any) -> None:
                content_index = get_content_index(block)
                if content_index == -1:
                    return
                b_type = block.get("type")
                if b_type == "text":
                    event_stream.push(
                        {
                            "type": "text_end",
                            "contentIndex": content_index,
                            "content": block.get("text", ""),
                            "partial": output,
                        }
                    )
                elif b_type == "thinking":
                    event_stream.push(
                        {
                            "type": "thinking_end",
                            "contentIndex": content_index,
                            "content": block.get("thinking", ""),
                            "partial": output,
                        }
                    )
                elif b_type == "toolCall":
                    block["arguments"] = parse_streaming_json(block.get("partialArgs"))
                    block.pop("partialArgs", None)
                    block.pop("streamIndex", None)
                    event_stream.push(
                        {
                            "type": "toolcall_end",
                            "contentIndex": content_index,
                            "toolCall": cast(ToolCall, block),
                            "partial": output,
                        }
                    )

            def ensure_text_block() -> TextContent:
                nonlocal text_block
                if not text_block:
                    text_block = {"type": "text", "text": ""}
                    blocks.append(text_block)
                    event_stream.push(
                        {
                            "type": "text_start",
                            "contentIndex": get_content_index(text_block),
                            "partial": output,
                        }
                    )
                return text_block

            def ensure_thinking_block(thinking_signature: str) -> ThinkingContent:
                nonlocal thinking_block
                if not thinking_block:
                    thinking_block = {
                        "type": "thinking",
                        "thinking": "",
                        "thinkingSignature": thinking_signature,
                    }
                    blocks.append(thinking_block)
                    event_stream.push(
                        {
                            "type": "thinking_start",
                            "contentIndex": get_content_index(thinking_block),
                            "partial": output,
                        }
                    )
                return thinking_block

            def ensure_tool_call_block(tool_call: Any) -> Dict[str, Any]:
                stream_index = tool_call.index if hasattr(tool_call, "index") else None
                block = None
                if stream_index is not None:
                    block = tool_call_blocks_by_index.get(stream_index)
                if not block and hasattr(tool_call, "id") and tool_call.id:
                    block = tool_call_blocks_by_id.get(tool_call.id)

                if not block:
                    block = {
                        "type": "toolCall",
                        "id": getattr(tool_call, "id", None) or "",
                        "name": (
                            tool_call.function.name
                            if (hasattr(tool_call, "function") and tool_call.function)
                            else ""
                        )
                        or "",
                        "arguments": {},
                        "partialArgs": "",
                        "streamIndex": stream_index,
                    }
                    if stream_index is not None:
                        tool_call_blocks_by_index[stream_index] = block
                    if getattr(tool_call, "id", None):
                        tool_call_blocks_by_id[tool_call.id] = block
                    blocks.append(cast(Any, block))
                    event_stream.push(
                        {
                            "type": "toolcall_start",
                            "contentIndex": get_content_index(block),
                            "partial": output,
                        }
                    )

                if stream_index is not None and block.get("streamIndex") is None:
                    block["streamIndex"] = stream_index
                    tool_call_blocks_by_index[stream_index] = block
                if hasattr(tool_call, "id") and tool_call.id:
                    tool_call_blocks_by_id[tool_call.id] = block
                return block

            async for chunk in openai_stream:
                if not chunk:
                    continue

                if getattr(chunk, "id", None):
                    if not output.get("responseId"):
                        output["responseId"] = chunk.id
                if getattr(chunk, "model", None) and chunk.model != model["id"]:
                    if not output.get("responseModel"):
                        output["responseModel"] = chunk.model
                if getattr(chunk, "usage", None):
                    output["usage"] = parse_chunk_usage(chunk.usage, model)

                choices = getattr(chunk, "choices", None)
                choice = choices[0] if (choices and len(choices) > 0) else None
                if not choice:
                    continue

                if not getattr(chunk, "usage", None) and hasattr(choice, "usage") and choice.usage:
                    output["usage"] = parse_chunk_usage(choice.usage, model)

                if getattr(choice, "finish_reason", None):
                    finish_reason_result = map_stop_reason(choice.finish_reason)
                    output["stopReason"] = finish_reason_result["stopReason"]
                    if finish_reason_result.get("errorMessage"):
                        output["errorMessage"] = finish_reason_result["errorMessage"]
                    has_finish_reason = True

                delta = getattr(choice, "delta", None)
                if delta:
                    content_val = getattr(delta, "content", None)
                    if content_val is not None and len(content_val) > 0:
                        text_blk = ensure_text_block()
                        text_blk["text"] += content_val
                        event_stream.push(
                            {
                                "type": "text_delta",
                                "contentIndex": get_content_index(text_blk),
                                "delta": content_val,
                                "partial": output,
                            }
                        )

                    reasoning_fields = ["reasoning_content", "reasoning", "reasoning_text"]
                    found_reasoning_field = None
                    for field in reasoning_fields:
                        val = getattr(delta, field, None)
                        if val is None and hasattr(delta, "model_extra"):
                            extra = delta.model_extra or {}
                            val = extra.get(field)
                        if isinstance(val, str) and len(val) > 0:
                            found_reasoning_field = field
                            break

                    if found_reasoning_field:
                        val = getattr(delta, found_reasoning_field, None)
                        if val is None and hasattr(delta, "model_extra"):
                            val = (delta.model_extra or {}).get(found_reasoning_field)
                        if isinstance(val, str) and len(val) > 0:
                            thinking_signature = (
                                "reasoning_content"
                                if (
                                    model.get("provider") == "opencode-go"
                                    and found_reasoning_field == "reasoning"
                                )
                                else found_reasoning_field
                            )
                            thinking_blk = ensure_thinking_block(thinking_signature)
                            thinking_blk["thinking"] += val
                            event_stream.push(
                                {
                                    "type": "thinking_delta",
                                    "contentIndex": get_content_index(thinking_blk),
                                    "delta": val,
                                    "partial": output,
                                }
                            )

                    tool_calls = getattr(delta, "tool_calls", None)
                    if tool_calls:
                        for tc in tool_calls:
                            tc_blk = ensure_tool_call_block(tc)
                            if not tc_blk.get("id") and getattr(tc, "id", None):
                                tc_blk["id"] = tc.id
                                tool_call_blocks_by_id[tc.id] = tc_blk
                            if (
                                not tc_blk.get("name")
                                and hasattr(tc, "function")
                                and tc.function
                                and getattr(tc.function, "name", None)
                            ):
                                tc_blk["name"] = tc.function.name

                            t_delta = ""
                            if (
                                hasattr(tc, "function")
                                and tc.function
                                and getattr(tc.function, "arguments", None)
                            ):
                                t_delta = tc.function.arguments
                                tc_blk["partialArgs"] = (
                                    tc_blk.get("partialArgs") or ""
                                ) + tc.function.arguments
                                tc_blk["arguments"] = parse_streaming_json(tc_blk["partialArgs"])

                            event_stream.push(
                                {
                                    "type": "toolcall_delta",
                                    "contentIndex": get_content_index(tc_blk),
                                    "delta": t_delta,
                                    "partial": output,
                                }
                            )

                    reasoning_details = getattr(delta, "reasoning_details", None)
                    if reasoning_details is None and hasattr(delta, "model_extra"):
                        reasoning_details = (delta.model_extra or {}).get("reasoning_details")
                    if reasoning_details and isinstance(reasoning_details, list):
                        for detail in reasoning_details:
                            if (
                                isinstance(detail, dict)
                                and detail.get("type") == "reasoning.encrypted"
                                and detail.get("id")
                                and detail.get("data")
                            ):
                                detail_id = detail.get("id")
                                for tc_block in output["content"]:
                                    if (
                                        tc_block.get("type") == "toolCall"
                                        and tc_block.get("id") == detail_id
                                    ):
                                        cast(Dict[str, Any], tc_block)["thoughtSignature"] = (
                                            json.dumps(detail)
                                        )

            for finish_blk in blocks:
                finish_block(finish_blk)

            signal = options_dict.get("signal")
            if signal and getattr(signal, "aborted", False):
                raise ValueError("Request was aborted")

            if output.get("stopReason") == "aborted":
                raise ValueError("Request was aborted")
            if output.get("stopReason") == "error":
                raise ValueError(
                    output.get("errorMessage") or "Provider returned an error stop reason"
                )
            if not has_finish_reason:
                raise ValueError("Stream ended without finish_reason")

            event_stream.push(
                {
                    "type": "done",
                    "reason": cast(
                        Literal["stop", "length", "toolUse"], output.get("stopReason", "stop")
                    ),
                    "message": output,
                }
            )
            event_stream.end()

        except Exception as error:
            for error_blk in output["content"]:
                clean_blk = cast(Any, error_blk)
                clean_blk.pop("index", None)
                clean_blk.pop("partialArgs", None)
                clean_blk.pop("streamIndex", None)

            signal = options_dict.get("signal") if options else None
            output["stopReason"] = (
                "aborted" if (signal and getattr(signal, "aborted", False)) else "error"
            )
            output["errorMessage"] = str(error)
            event_stream.push(
                {
                    "type": "error",
                    "reason": cast(Literal["aborted", "error"], output.get("stopReason", "error")),
                    "error": output,
                }
            )
            event_stream.end()

    asyncio.create_task(run())
    return event_stream


def stream_simple_openai_completions(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessageEventStream:
    options_dict = options or {}
    api_key = options_dict.get("apiKey")
    if not api_key:
        raise ValueError(f"No API key for provider: {model.get('provider')}")

    base = build_base_options(model, options, api_key)
    clamped_reasoning = (
        clamp_thinking_level(model, cast(ModelThinkingLevel, options_dict["reasoning"]))
        if options_dict.get("reasoning")
        else None
    )
    reasoning_effort = None if clamped_reasoning == "off" else clamped_reasoning
    tool_choice = cast(Any, options_dict.get("toolChoice"))

    merged_options = OpenAICompletionsOptions(**base)
    if reasoning_effort is not None:
        merged_options["reasoningEffort"] = reasoning_effort
    if tool_choice is not None:
        merged_options["toolChoice"] = tool_choice

    return stream_openai_completions(model, context, merged_options)


def create_client(
    model: Model,
    context: Context,
    api_key: str,
    options_headers: Optional[Dict[str, str]] = None,
    session_id: Optional[str] = None,
    compat: Optional[Dict[str, Any]] = None,
    max_retries: Optional[int] = None,
) -> AsyncOpenAI:
    if compat is None:
        compat = get_compat(model)
    headers = dict(model.get("headers") or {})

    if model.get("provider") == "github-copilot":
        has_images = has_copilot_vision_input(context.get("messages", []))
        copilot_headers = build_copilot_dynamic_headers(
            {
                "messages": context.get("messages", []),
                "hasImages": has_images,
            }
        )
        headers.update(copilot_headers)

    if session_id and compat.get("sendSessionAffinityHeaders"):
        headers["session_id"] = session_id
        headers["x-client-request-id"] = session_id
        headers["x-session-affinity"] = session_id

    if options_headers:
        headers.update(options_headers)

    proxy_config = create_http_proxy_agents_for_target(
        model.get("baseUrl") or "https://api.openai.com"
    )
    http_client = None
    if proxy_config:
        proxy_url = proxy_config.get("https") or proxy_config.get("http")
        http_client = httpx.AsyncClient(proxy=proxy_url)

    base_url = (
        resolve_cloudflare_base_url(model)
        if is_cloudflare_provider(model.get("provider", ""))
        else model.get("baseUrl")
    )

    default_headers = dict(headers)
    if model.get("provider") == "cloudflare-ai-gateway":
        default_headers.update(
            {
                "Authorization": headers.get("Authorization") or "",
                "cf-aig-authorization": f"Bearer {api_key}",
            }
        )

    client_kwargs: Dict[str, Any] = {
        "api_key": api_key,
        "base_url": base_url,
        "http_client": http_client,
        "default_headers": default_headers,
    }
    if max_retries is not None:
        client_kwargs["max_retries"] = max_retries
    return AsyncOpenAI(**client_kwargs)


def build_params(
    model: Model,
    context: Context,
    options: Optional[OpenAICompletionsOptions] = None,
    compat: Optional[Dict[str, Any]] = None,
    cache_retention: str = "short",
) -> Dict[str, Any]:
    if compat is None:
        compat = get_compat(model)
    options_dict = cast(Dict[str, Any], options or {})

    messages = convert_messages(model, context, compat)
    cache_control = get_compat_cache_control(compat, cache_retention)

    params: Dict[str, Any] = {
        "model": model["id"],
        "messages": messages,
        "stream": True,
    }

    is_openai_official = "api.openai.com" in model.get("baseUrl", "")
    if (is_openai_official and cache_retention != "none") or (
        cache_retention == "long" and compat.get("supportsLongCacheRetention")
    ):
        params["prompt_cache_key"] = clamp_openai_prompt_cache_key(options_dict.get("sessionId"))

    if cache_retention == "long" and compat.get("supportsLongCacheRetention"):
        params["prompt_cache_retention"] = "24h"

    if compat.get("supportsUsageInStreaming") is not False:
        params["stream_options"] = {"include_usage": True}

    if compat.get("supportsStore"):
        params["store"] = False

    max_tokens = options_dict.get("maxTokens")
    if max_tokens:
        if compat.get("maxTokensField") == "max_tokens":
            params["max_tokens"] = max_tokens
        else:
            params["max_completion_tokens"] = max_tokens

    temperature = options_dict.get("temperature")
    if temperature is not None:
        params["temperature"] = temperature

    tools = context.get("tools")
    if tools and len(tools) > 0:
        params["tools"] = convert_tools(tools, compat)
        if compat.get("zaiToolStream"):
            params["tool_stream"] = True
    elif has_tool_history(context.get("messages", [])):
        params["tools"] = []

    if cache_control:
        apply_anthropic_cache_control(messages, params.get("tools"), cache_control)

    tool_choice = options_dict.get("toolChoice")
    if tool_choice:
        params["tool_choice"] = tool_choice

    thinking_format = compat.get("thinkingFormat")
    reasoning_effort = options_dict.get("reasoningEffort")
    is_reasoning_enabled = model.get("reasoning", False)

    if thinking_format == "zai" and is_reasoning_enabled:
        params["enable_thinking"] = bool(reasoning_effort)
    elif thinking_format == "qwen" and is_reasoning_enabled:
        params["enable_thinking"] = bool(reasoning_effort)
    elif thinking_format == "qwen-chat-template" and is_reasoning_enabled:
        params["chat_template_kwargs"] = {
            "enable_thinking": bool(reasoning_effort),
            "preserve_thinking": True,
        }
    elif thinking_format == "deepseek" and is_reasoning_enabled:
        params["thinking"] = {"type": "enabled" if reasoning_effort else "disabled"}
        if reasoning_effort and compat.get("supportsReasoningEffort"):
            thinking_level_map = model.get("thinkingLevelMap") or {}
            params["reasoning_effort"] = (
                thinking_level_map.get(reasoning_effort) or reasoning_effort
            )
    elif thinking_format == "openrouter" and is_reasoning_enabled:
        thinking_level_map = model.get("thinkingLevelMap") or {}
        if reasoning_effort:
            params["reasoning"] = {
                "effort": thinking_level_map.get(reasoning_effort) or reasoning_effort
            }
        elif thinking_level_map.get("off") is not None:
            params["reasoning"] = {"effort": thinking_level_map.get("off") or "none"}
    elif thinking_format == "ant-ling" and is_reasoning_enabled and reasoning_effort:
        thinking_level_map = model.get("thinkingLevelMap") or {}
        effort = thinking_level_map.get(reasoning_effort)
        if isinstance(effort, str):
            params["reasoning"] = {"effort": effort}
    elif thinking_format == "together" and is_reasoning_enabled:
        params["reasoning"] = {"enabled": bool(reasoning_effort)}
        if reasoning_effort and compat.get("supportsReasoningEffort"):
            thinking_level_map = model.get("thinkingLevelMap") or {}
            params["reasoning_effort"] = (
                thinking_level_map.get(reasoning_effort) or reasoning_effort
            )
    elif thinking_format == "string-thinking" and is_reasoning_enabled:
        thinking_level_map = model.get("thinkingLevelMap") or {}
        if reasoning_effort:
            params["thinking"] = thinking_level_map.get(reasoning_effort) or reasoning_effort
        elif thinking_level_map.get("off") is not None:
            params["thinking"] = thinking_level_map.get("off") or "none"
    elif reasoning_effort and is_reasoning_enabled and compat.get("supportsReasoningEffort"):
        thinking_level_map = model.get("thinkingLevelMap") or {}
        params["reasoning_effort"] = thinking_level_map.get(reasoning_effort) or reasoning_effort
    elif not reasoning_effort and is_reasoning_enabled and compat.get("supportsReasoningEffort"):
        thinking_level_map = model.get("thinkingLevelMap") or {}
        off_value = thinking_level_map.get("off")
        if isinstance(off_value, str):
            params["reasoning_effort"] = off_value

    if "openrouter.ai" in model.get("baseUrl", "") and model.get("compat", {}).get(
        "openRouterRouting"
    ):
        params["provider"] = model["compat"]["openRouterRouting"]

    if "ai-gateway.vercel.sh" in model.get("baseUrl", "") and model.get("compat", {}).get(
        "vercelGatewayRouting"
    ):
        routing = model["compat"]["vercelGatewayRouting"]
        if routing.get("only") or routing.get("order"):
            gateway_options: Dict[str, Any] = {}
            if routing.get("only"):
                gateway_options["only"] = routing["only"]
            if routing.get("order"):
                gateway_options["order"] = routing["order"]
            params["providerOptions"] = {"gateway": gateway_options}

    return params


def get_compat_cache_control(
    compat: Dict[str, Any],
    cache_retention: str,
) -> Optional[OpenAICompatCacheControl]:
    if compat.get("cacheControlFormat") != "anthropic" or cache_retention == "none":
        return None

    ttl = "1h" if (cache_retention == "long" and compat.get("supportsLongCacheRetention")) else None
    res: OpenAICompatCacheControl = {"type": "ephemeral"}
    if ttl:
        res["ttl"] = ttl
    return res


def apply_anthropic_cache_control(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    cache_control: OpenAICompatCacheControl,
) -> None:
    add_cache_control_to_system_prompt(messages, cache_control)
    add_cache_control_to_last_tool(tools, cache_control)
    add_cache_control_to_last_conversation_message(messages, cache_control)


def add_cache_control_to_system_prompt(
    messages: List[Dict[str, Any]],
    cache_control: OpenAICompatCacheControl,
) -> None:
    for message in messages:
        if message.get("role") in ("system", "developer"):
            add_cache_control_to_instruction_message(message, cache_control)
            return


def add_cache_control_to_last_conversation_message(
    messages: List[Dict[str, Any]],
    cache_control: OpenAICompatCacheControl,
) -> None:
    for message in reversed(messages):
        if message.get("role") in ("user", "assistant"):
            if add_cache_control_to_message(message, cache_control):
                return


def add_cache_control_to_last_tool(
    tools: Optional[List[Dict[str, Any]]],
    cache_control: OpenAICompatCacheControl,
) -> None:
    if not tools:
        return
    tools[-1]["cache_control"] = cache_control


def add_cache_control_to_instruction_message(
    message: Dict[str, Any],
    cache_control: OpenAICompatCacheControl,
) -> bool:
    return add_cache_control_to_text_content(message, cache_control)


def add_cache_control_to_message(
    message: Dict[str, Any],
    cache_control: OpenAICompatCacheControl,
) -> bool:
    if message.get("role") in ("user", "assistant"):
        return add_cache_control_to_text_content(message, cache_control)
    return False


def add_cache_control_to_text_content(
    message: Dict[str, Any],
    cache_control: OpenAICompatCacheControl,
) -> bool:
    content = message.get("content")
    if isinstance(content, str):
        if len(content) == 0:
            return False
        message["content"] = [
            {
                "type": "text",
                "text": content,
                "cache_control": cache_control,
            }
        ]
        return True

    if not isinstance(content, list):
        return False

    for part in reversed(content):
        if part and part.get("type") == "text":
            part["cache_control"] = cache_control
            return True

    return False


def convert_messages(
    model: Model,
    context: Context,
    compat: Dict[str, Any],
) -> List[Dict[str, Any]]:
    params: List[Dict[str, Any]] = []

    def normalize_tool_call_id(id_val: str, model: Model, assistant_msg: AssistantMessage) -> str:
        if "|" in id_val:
            call_id = id_val.split("|")[0]

            return re.sub(r"[^a-zA-Z0-9_-]", "_", call_id)[:40]
        if model.get("provider") == "openai":
            return id_val[:40] if len(id_val) > 40 else id_val
        return id_val

    transformed_messages = transform_messages(
        context.get("messages", []), model, normalize_tool_call_id
    )

    system_prompt = context.get("systemPrompt")
    if system_prompt:
        use_developer_role = model.get("reasoning") and compat.get("supportsDeveloperRole")
        role = "developer" if use_developer_role else "system"
        params.append({"role": role, "content": sanitize_surrogates(system_prompt)})

    last_role = None
    i = 0
    while i < len(transformed_messages):
        msg = transformed_messages[i]
        msg_role = msg.get("role")
        msg_content = msg.get("content")

        if (
            compat.get("requiresAssistantAfterToolResult")
            and last_role == "toolResult"
            and msg_role == "user"
        ):
            params.append(
                {
                    "role": "assistant",
                    "content": "I have processed the tool results.",
                }
            )

        if msg_role == "user":
            if isinstance(msg_content, str):
                params.append(
                    {
                        "role": "user",
                        "content": sanitize_surrogates(msg_content),
                    }
                )
            else:
                content_list: List[Dict[str, Any]] = []
                for item in cast(List[Any], msg_content or []):
                    if item.get("type") == "text":
                        content_list.append(
                            {
                                "type": "text",
                                "text": sanitize_surrogates(item.get("text", "")),
                            }
                        )
                    else:
                        content_list.append(
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{item.get('mimeType')};base64,{item.get('data')}",
                                },
                            }
                        )
                if not content_list:
                    i += 1
                    continue
                params.append(
                    {
                        "role": "user",
                        "content": content_list,
                    }
                )
        elif msg_role == "assistant":
            assistant_msg: Dict[str, Any] = {
                "role": "assistant",
                "content": "" if compat.get("requiresAssistantAfterToolResult") else None,
            }

            assistant_text_parts = [
                {
                    "type": "text",
                    "text": sanitize_surrogates(block.get("text", "")),
                }
                for block in cast(List[Any], msg_content or [])
                if is_text_content_block(block) and len(block.get("text", "").strip()) > 0
            ]
            assistant_text = "".join(part["text"] for part in assistant_text_parts)

            non_empty_thinking_blocks = [
                block
                for block in cast(List[Any], msg_content or [])
                if is_thinking_content_block(block) and len(block.get("thinking", "").strip()) > 0
            ]

            if non_empty_thinking_blocks:
                if compat.get("requiresThinkingAsText"):
                    thinking_text = "\n\n".join(
                        sanitize_surrogates(block.get("thinking", ""))
                        for block in cast(List[Any], non_empty_thinking_blocks)
                    )
                    assistant_msg["content"] = [
                        {"type": "text", "text": thinking_text}
                    ] + assistant_text_parts
                else:
                    if len(assistant_text) > 0:
                        assistant_msg["content"] = assistant_text

                    signature = non_empty_thinking_blocks[0].get("thinkingSignature")
                    if model.get("provider") == "opencode-go" and signature == "reasoning":
                        signature = "reasoning_content"
                    if signature and len(signature) > 0:
                        assistant_msg[signature] = "\n".join(
                            block.get("thinking", "")
                            for block in cast(List[Any], non_empty_thinking_blocks)
                        )
            elif len(assistant_text) > 0:
                assistant_msg["content"] = assistant_text

            tool_calls = [
                block for block in cast(List[Any], msg_content or []) if is_tool_call_block(block)
            ]
            if tool_calls:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.get("id"),
                        "type": "function",
                        "function": {
                            "name": tc.get("name"),
                            "arguments": json.dumps(tc.get("arguments", {})),
                        },
                    }
                    for tc in tool_calls
                ]
                reasoning_details = []
                for tc in tool_calls:
                    tsig = tc.get("thoughtSignature")
                    if tsig:
                        try:
                            reasoning_details.append(json.loads(tsig))
                        except Exception:
                            pass
                if reasoning_details:
                    assistant_msg["reasoning_details"] = reasoning_details

            if (
                compat.get("requiresReasoningContentOnAssistantMessages")
                and model.get("reasoning")
                and assistant_msg.get("reasoning_content") is None
            ):
                assistant_msg["reasoning_content"] = ""

            content_field = assistant_msg.get("content")
            has_content = content_field is not None and (
                len(content_field) > 0 if isinstance(content_field, (str, list)) else True
            )
            if not has_content and not assistant_msg.get("tool_calls"):
                i += 1
                continue

            params.append(assistant_msg)
        elif msg_role == "toolResult":
            image_blocks = []
            j = i
            while (
                j < len(transformed_messages)
                and transformed_messages[j].get("role") == "toolResult"
            ):
                tool_msg = cast(Dict[str, Any], transformed_messages[j])
                tool_msg_content = cast(List[Any], tool_msg.get("content") or [])

                text_result = "\n".join(
                    block.get("text", "")
                    for block in tool_msg_content
                    if is_text_content_block(block)
                )
                has_images = any(is_image_content_block(block) for block in tool_msg_content)

                has_text = len(text_result) > 0
                tool_result_msg: Dict[str, Any] = {
                    "role": "tool",
                    "content": sanitize_surrogates(
                        text_result if has_text else "(see attached image)"
                    ),
                    "tool_call_id": tool_msg.get("toolCallId"),
                }
                if compat.get("requiresToolResultName") and tool_msg.get("toolName"):
                    tool_result_msg["name"] = tool_msg["toolName"]
                params.append(tool_result_msg)

                if has_images and "image" in model.get("input", []):
                    for block in tool_msg_content:
                        if is_image_content_block(block):
                            image_blocks.append(
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:{block.get('mimeType')};base64,{block.get('data')}",
                                    },
                                }
                            )
                j += 1

            i = j

            if image_blocks:
                if compat.get("requiresAssistantAfterToolResult"):
                    params.append(
                        {
                            "role": "assistant",
                            "content": "I have processed the tool results.",
                        }
                    )
                params.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Attached image(s) from tool result:",
                            }
                        ]
                        + image_blocks,
                    }
                )
                last_role = "user"
            else:
                last_role = "toolResult"
            continue

        last_role = msg_role
        i += 1

    return params


def convert_tools(
    tools: List[Tool],
    compat: Dict[str, Any],
) -> List[Dict[str, Any]]:
    res = []
    for tool in tools:
        t_dict: Dict[str, Any] = {
            "type": "function",
            "function": {
                "name": tool.get("name"),
                "description": tool.get("description"),
                "parameters": tool.get("parameters"),
            },
        }
        if compat.get("supportsStrictMode") is not False:
            t_dict["function"]["strict"] = False
        res.append(t_dict)
    return res


def parse_chunk_usage(
    raw_usage: Any,
    model: Model,
) -> Usage:

    def get_val(obj: Any, key: str) -> Any:
        if isinstance(obj, dict):
            return obj.get(key)
        return getattr(obj, key, None)

    prompt_tokens = get_val(raw_usage, "prompt_tokens") or 0
    completion_tokens = get_val(raw_usage, "completion_tokens") or 0
    prompt_cache_hit_tokens = get_val(raw_usage, "prompt_cache_hit_tokens") or 0

    prompt_tokens_details = get_val(raw_usage, "prompt_tokens_details")
    cached_tokens = 0
    cache_write_tokens = 0
    if prompt_tokens_details:
        cached_tokens = get_val(prompt_tokens_details, "cached_tokens") or 0
        cache_write_tokens = get_val(prompt_tokens_details, "cache_write_tokens") or 0

    cache_read_tokens = cached_tokens or prompt_cache_hit_tokens or 0

    input_tokens = max(0, prompt_tokens - cache_read_tokens - cache_write_tokens)
    output_tokens = completion_tokens

    usage: Usage = {
        "input": input_tokens,
        "output": output_tokens,
        "cacheRead": cache_read_tokens,
        "cacheWrite": cache_write_tokens,
        "totalTokens": input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
        "cost": {
            "input": 0.0,
            "output": 0.0,
            "cacheRead": 0.0,
            "cacheWrite": 0.0,
            "total": 0.0,
        },
    }
    calculate_cost(model, usage)
    return usage


def map_stop_reason(reason: Optional[str]) -> Dict[str, Any]:
    if reason is None:
        return {"stopReason": "stop"}
    if reason in ("stop", "end"):
        return {"stopReason": "stop"}
    if reason == "length":
        return {"stopReason": "length"}
    if reason in ("function_call", "tool_calls"):
        return {"stopReason": "toolUse"}
    if reason == "content_filter":
        return {"stopReason": "error", "errorMessage": "Provider finish_reason: content_filter"}
    if reason == "network_error":
        return {"stopReason": "error", "errorMessage": "Provider finish_reason: network_error"}
    return {
        "stopReason": "error",
        "errorMessage": f"Provider finish_reason: {reason}",
    }


def detect_compat(model: Model) -> Dict[str, Any]:
    provider = model.get("provider", "")
    base_url = model.get("baseUrl", "")

    is_zai = (
        provider == "zai"
        or provider == "zai-coding-cn"
        or "api.z.ai" in base_url
        or "open.bigmodel.cn" in base_url
    )
    is_together = (
        provider == "together" or "api.together.ai" in base_url or "api.together.xyz" in base_url
    )
    is_moonshot = (
        provider == "moonshotai" or provider == "moonshotai-cn" or "api.moonshot." in base_url
    )
    is_openrouter = provider == "openrouter" or "openrouter.ai" in base_url
    is_cloudflare_workers_ai = (
        provider == "cloudflare-workers-ai" or "api.cloudflare.com" in base_url
    )
    is_cloudflare_ai_gateway = (
        provider == "cloudflare-ai-gateway" or "gateway.ai.cloudflare.com" in base_url
    )
    is_nvidia = provider == "nvidia" or "integrate.api.nvidia.com" in base_url
    is_ant_ling = provider == "ant-ling" or "api.ant-ling.com" in base_url

    is_non_standard = (
        is_nvidia
        or provider == "cerebras"
        or "cerebras.ai" in base_url
        or provider == "xai"
        or "api.x.ai" in base_url
        or is_together
        or "chutes.ai" in base_url
        or "deepseek.com" in base_url
        or is_zai
        or is_moonshot
        or provider == "opencode"
        or "opencode.ai" in base_url
        or is_cloudflare_workers_ai
        or is_cloudflare_ai_gateway
        or is_ant_ling
    )

    use_max_tokens = (
        "chutes.ai" in base_url
        or is_moonshot
        or is_cloudflare_ai_gateway
        or is_together
        or is_nvidia
        or is_ant_ling
    )

    is_grok = provider == "xai" or "api.x.ai" in base_url
    is_deepseek = provider == "deepseek" or "deepseek.com" in base_url
    is_openrouter_dev_role = is_openrouter and (
        model["id"].startswith("anthropic/") or model["id"].startswith("openai/")
    )
    cache_control_format = (
        "anthropic" if (is_openrouter and model["id"].startswith("anthropic/")) else None
    )

    return {
        "supportsStore": not is_non_standard,
        "supportsDeveloperRole": is_openrouter_dev_role
        or (not is_non_standard and not is_openrouter),
        "supportsReasoningEffort": (
            not is_grok
            and not is_zai
            and not is_moonshot
            and not is_together
            and not is_cloudflare_ai_gateway
            and not is_nvidia
            and not is_ant_ling
        ),
        "supportsUsageInStreaming": True,
        "maxTokensField": "max_tokens" if use_max_tokens else "max_completion_tokens",
        "requiresToolResultName": False,
        "requiresAssistantAfterToolResult": False,
        "requiresThinkingAsText": False,
        "requiresReasoningContentOnAssistantMessages": is_deepseek,
        "thinkingFormat": (
            "deepseek"
            if is_deepseek
            else (
                "zai"
                if is_zai
                else (
                    "together"
                    if is_together
                    else "ant-ling" if is_ant_ling else "openrouter" if is_openrouter else "openai"
                )
            )
        ),
        "openRouterRouting": {},
        "vercelGatewayRouting": {},
        "zaiToolStream": False,
        "supportsStrictMode": not is_moonshot
        and not is_together
        and not is_cloudflare_ai_gateway
        and not is_nvidia,
        "cacheControlFormat": cache_control_format,
        "sendSessionAffinityHeaders": False,
        "supportsLongCacheRetention": not (
            is_together
            or is_cloudflare_workers_ai
            or is_cloudflare_ai_gateway
            or is_nvidia
            or is_ant_ling
        ),
    }


def get_compat(model: Model) -> Dict[str, Any]:
    detected = detect_compat(model)
    model_compat = model.get("compat") or {}

    res = {}
    for k, v in detected.items():
        res[k] = model_compat.get(k) if model_compat.get(k) is not None else v
    return res
