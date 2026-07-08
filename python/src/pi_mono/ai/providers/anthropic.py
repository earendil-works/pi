import asyncio
import inspect
import time
from typing import Any, Dict, List, Literal, Mapping, Optional, Union, cast


import httpx
from anthropic import AsyncAnthropic

from pi_mono.ai.models import calculate_cost
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Message,
    Model,
    ModelThinkingLevel,
    SimpleStreamOptions,
    StopReason,
    StreamOptions,
    ThinkingBudgets,
    ThinkingLevel,
    Tool,
    ToolCall,
)
from pi_mono.utils.event_stream import AssistantMessageEventStream
from pi_mono.utils.json_parse import parse_streaming_json
from pi_mono.utils.node_http_proxy import create_http_proxy_agents_for_target
from pi_mono.utils.sanitize_unicode import sanitize_surrogates
from pi_mono.ai.providers.simple_options import build_base_options, adjust_max_tokens_for_thinking
from pi_mono.ai.providers.transform_messages import transform_messages
from pi_mono.ai.providers.cloudflare import resolve_cloudflare_base_url
from pi_mono.ai.providers.github_copilot_headers import (
    build_copilot_dynamic_headers,
    has_copilot_vision_input,
)

CLAUDE_CODE_VERSION = "2.1.75"

_SUPPORTS_OUTPUT_CONFIG: bool | None = None


def _supports_output_config() -> bool:
    global _SUPPORTS_OUTPUT_CONFIG
    if _SUPPORTS_OUTPUT_CONFIG is None:
        _SUPPORTS_OUTPUT_CONFIG = (
            "output_config" in inspect.signature(AsyncAnthropic().messages.create).parameters
        )
    return _SUPPORTS_OUTPUT_CONFIG


CLAUDE_CODE_TOOLS = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
]

CC_TOOL_LOOKUP = {t.lower(): t for t in CLAUDE_CODE_TOOLS}


def to_claude_code_name(name: str) -> str:
    return CC_TOOL_LOOKUP.get(name.lower(), name)


def from_claude_code_name(name: str, tools: Optional[List[Tool]] = None) -> str:
    if tools:
        lower_name = name.lower()
        for tool in tools:
            if tool.get("name", "").lower() == lower_name:
                return tool["name"]
    return name


def resolve_cache_retention(cache_retention: Optional[str] = None) -> str:
    if cache_retention:
        return cache_retention
    if os_retention := os_environ_get("PI_CACHE_RETENTION"):
        if os_retention == "long":
            return "long"
    return "short"


def os_environ_get(key: str) -> Optional[str]:
    # Import os locally if needed, but top-level import is cleaner.
    import os

    return os.environ.get(key)


def get_anthropic_compat(model: Model) -> Dict[str, bool]:
    is_fireworks = model.get("provider") == "fireworks"
    is_cf = model.get("provider") == "cloudflare-ai-gateway" and "anthropic" in (
        model.get("baseUrl") or ""
    )
    compat = model.get("compat") or {}
    return {
        "supportsEagerToolInputStreaming": compat.get(
            "supportsEagerToolInputStreaming", not is_fireworks
        ),
        "supportsLongCacheRetention": compat.get("supportsLongCacheRetention", not is_fireworks),
        "sendSessionAffinityHeaders": compat.get(
            "sendSessionAffinityHeaders", is_fireworks or is_cf
        ),
        "supportsCacheControlOnTools": compat.get("supportsCacheControlOnTools", not is_fireworks),
        "supportsTemperature": compat.get("supportsTemperature", True),
        "allowEmptySignature": compat.get("allowEmptySignature", False),
    }


def get_cache_control(model: Model, cache_retention: Optional[str] = None) -> Dict[str, Any]:
    retention = resolve_cache_retention(cache_retention)
    if retention == "none":
        return {"retention": retention}
    compat = get_anthropic_compat(model)
    ttl = "1h" if retention == "long" and compat["supportsLongCacheRetention"] else None
    cache_control = {"type": "ephemeral"}
    if ttl:
        cache_control["ttl"] = ttl
    return {"retention": retention, "cacheControl": cache_control}


def convert_content_blocks(content: Any) -> Union[str, List[Dict[str, Any]]]:
    if not isinstance(content, list):
        return ""
    items = [c for c in content if isinstance(c, dict)]
    has_images = any(c.get("type") == "image" for c in items)
    if not has_images:
        return sanitize_surrogates(
            "\n".join(c.get("text", "") for c in items if c.get("type") == "text")
        )

    blocks: List[Dict[str, Any]] = []
    for item in items:
        if item.get("type") == "text":
            blocks.append(
                {
                    "type": "text",
                    "text": sanitize_surrogates(item.get("text", "")),
                }
            )
        elif item.get("type") == "image":
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": item.get("mimeType"),
                        "data": item.get("data"),
                    },
                }
            )

    has_text = any(b.get("type") == "text" for b in blocks)
    if not has_text:
        blocks.insert(0, {"type": "text", "text": "(see attached image)"})

    return blocks


def merge_headers(*sources: Optional[Mapping[str, Optional[str]]]) -> Dict[str, str]:
    merged: Dict[str, str] = {}
    for headers in sources:
        if headers:
            for k, v in headers.items():
                if v is not None:
                    merged[k] = v
    return merged


def normalize_tool_call_id(id_val: str, model: Model, msg: AssistantMessage) -> str:
    return re_sub(r"[^a-zA-Z0-9_-]", "_", id_val)[:64]


def re_sub(pattern: str, repl: str, string: str) -> str:
    import re

    return re.sub(pattern, repl, string)


def is_oauth_token(api_key: str) -> bool:
    return "sk-ant-oat" in api_key


def shouldUseFineGrainedToolStreamingBeta(model: Model, context: Context) -> bool:
    tools = context.get("tools") or []
    compat = get_anthropic_compat(model)
    return bool(tools) and not compat["supportsEagerToolInputStreaming"]


def create_client(
    model: Model,
    api_key: str,
    interleaved_thinking: bool,
    use_beta_tool_streaming: bool,
    options_headers: Optional[Dict[str, str]] = None,
    dynamic_headers: Optional[Dict[str, str]] = None,
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    compat = model.get("compat") or {}
    needs_interleaved_beta = (
        interleaved_thinking and compat.get("forceAdaptiveThinking") is not True
    )
    beta_features: List[str] = []
    if use_beta_tool_streaming:
        beta_features.append("fine-grained-tool-streaming-2025-05-14")
    if needs_interleaved_beta:
        beta_features.append("interleaved-thinking-2025-05-14")

    # Proxy setup
    proxy_config = create_http_proxy_agents_for_target(
        model.get("baseUrl") or "https://api.anthropic.com"
    )
    http_client = None
    if proxy_config:
        proxy_url = proxy_config.get("https") or proxy_config.get("http")
        http_client = httpx.AsyncClient(proxy=proxy_url)

    is_oauth = is_oauth_token(api_key)

    if model.get("provider") == "cloudflare-ai-gateway":
        default_headers = merge_headers(
            {
                "accept": "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "cf-aig-authorization": f"Bearer {api_key}",
                "x-api-key": None,
                "Authorization": None,
                "anthropic-beta": ",".join(beta_features) if beta_features else None,
            },
            model.get("headers"),
            options_headers,
        )
        client = AsyncAnthropic(
            api_key="dummy",
            base_url=resolve_cloudflare_base_url(model),
            http_client=http_client,
            default_headers=default_headers,
        )
        return {"client": client, "isOAuthToken": False}

    if model.get("provider") == "github-copilot":
        default_headers = merge_headers(
            {
                "accept": "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "anthropic-beta": ",".join(beta_features) if beta_features else None,
            },
            model.get("headers"),
            dynamic_headers,
            options_headers,
        )
        client = AsyncAnthropic(
            api_key="dummy",
            auth_token=api_key,
            base_url=model.get("baseUrl"),
            http_client=http_client,
            default_headers=default_headers,
        )
        return {"client": client, "isOAuthToken": False}

    if is_oauth:
        beta_list = ["claude-code-20250219", "oauth-2025-04-20"] + beta_features
        default_headers = merge_headers(
            {
                "accept": "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "anthropic-beta": ",".join(beta_list),
                "user-agent": f"claude-cli/{CLAUDE_CODE_VERSION}",
                "x-app": "cli",
            },
            model.get("headers"),
            options_headers,
        )
        client = AsyncAnthropic(
            api_key="dummy",
            auth_token=api_key,
            base_url=model.get("baseUrl"),
            http_client=http_client,
            default_headers=default_headers,
        )
        return {"client": client, "isOAuthToken": True}

    # API key auth
    compat_res = get_anthropic_compat(model)
    session_affinity_headers = (
        {"x-session-affinity": session_id}
        if session_id and compat_res["sendSessionAffinityHeaders"]
        else {}
    )
    default_headers = merge_headers(
        {
            "accept": "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            "anthropic-beta": ",".join(beta_features) if beta_features else None,
        },
        session_affinity_headers,
        model.get("headers"),
        options_headers,
    )
    client = AsyncAnthropic(
        api_key=api_key,
        base_url=model.get("baseUrl"),
        http_client=http_client,
        default_headers=default_headers,
    )
    return {"client": client, "isOAuthToken": False}


def convert_messages(
    messages: List[Message],
    model: Model,
    is_oauth: bool,
    cache_control: Optional[Dict[str, Any]],
    allow_empty_signature: bool = False,
) -> List[Dict[str, Any]]:
    # Transform messages for cross-provider compatibility
    transformed = transform_messages(messages, model, normalize_tool_call_id)
    params_messages: List[Dict[str, Any]] = []

    i = 0
    while i < len(transformed):
        msg = transformed[i]
        role = msg.get("role")
        content = msg.get("content")

        if role == "user":
            if isinstance(content, str):
                if content.strip():
                    params_messages.append(
                        {
                            "role": "user",
                            "content": sanitize_surrogates(content),
                        }
                    )
            elif isinstance(content, list):
                blocks: List[Dict[str, Any]] = []
                for item_val in content:
                    if not isinstance(item_val, dict):
                        continue
                    item: Any = item_val
                    if item.get("type") == "text":
                        text_val = item.get("text") or ""
                        blocks.append(
                            {
                                "type": "text",
                                "text": sanitize_surrogates(str(text_val)),
                            }
                        )
                    elif item.get("type") == "image":
                        blocks.append(
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": item.get("mimeType"),
                                    "data": item.get("data"),
                                },
                            }
                        )
                filtered = [
                    b for b in blocks if b.get("type") != "text" or b.get("text", "").strip()
                ]
                if not filtered:
                    i += 1
                    continue
                params_messages.append(
                    {
                        "role": "user",
                        "content": filtered,
                    }
                )

        elif role == "assistant":
            blocks = []
            content_list = content if isinstance(content, list) else []
            for b_item in content_list:
                if not isinstance(b_item, dict):
                    continue
                b: Any = b_item
                b_type = b.get("type")
                if b_type == "text":
                    text = b.get("text") or ""
                    if not isinstance(text, str) or not text.strip():
                        continue
                    blocks.append(
                        {
                            "type": "text",
                            "text": sanitize_surrogates(text),
                        }
                    )
                elif b_type == "thinking":
                    thinking = b.get("thinking") or ""
                    thinking_sig = b.get("thinkingSignature") or ""
                    if b.get("redacted"):
                        blocks.append(
                            {
                                "type": "redacted_thinking",
                                "data": thinking_sig,
                            }
                        )
                        continue
                    if not isinstance(thinking, str) or not thinking.strip():
                        continue
                    if not isinstance(thinking_sig, str) or not thinking_sig.strip():
                        if allow_empty_signature:
                            blocks.append(
                                {
                                    "type": "thinking",
                                    "thinking": sanitize_surrogates(thinking),
                                    "signature": "",
                                }
                            )
                        else:
                            blocks.append(
                                {
                                    "type": "text",
                                    "text": sanitize_surrogates(thinking),
                                }
                            )
                    else:
                        blocks.append(
                            {
                                "type": "thinking",
                                "thinking": sanitize_surrogates(thinking),
                                "signature": thinking_sig,
                            }
                        )
                elif b_type == "toolCall":
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": b.get("id"),
                            "name": (
                                to_claude_code_name(str(b.get("name", "")))
                                if is_oauth
                                else b.get("name")
                            ),
                            "input": b.get("arguments") or {},
                        }
                    )
            if not blocks:
                i += 1
                continue
            params_messages.append(
                {
                    "role": "assistant",
                    "content": blocks,
                }
            )

        elif role == "toolResult":
            # Collect consecutive tool results
            tool_results = []
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": msg.get("toolCallId"),
                    "content": convert_content_blocks(msg.get("content", [])),
                    "is_error": msg.get("isError", False),
                }
            )

            j = i + 1
            while j < len(transformed) and transformed[j].get("role") == "toolResult":
                next_msg = transformed[j]
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": next_msg.get("toolCallId"),
                        "content": convert_content_blocks(next_msg.get("content", [])),
                        "is_error": next_msg.get("isError", False),
                    }
                )
                j += 1
            i = j  # Skip already processed items

            params_messages.append(
                {
                    "role": "user",
                    "content": tool_results,
                }
            )
            continue

        i += 1

    # Add cache control to last user message
    if cache_control and params_messages:
        last_msg = params_messages[-1]
        if last_msg.get("role") == "user":
            content_val = last_msg.get("content")
            if isinstance(content_val, list):
                if content_val:
                    last_block = content_val[-1]
                    if last_block.get("type") in ("text", "image", "tool_result"):
                        last_block["cache_control"] = cache_control
            elif isinstance(content_val, str):
                last_msg["content"] = [
                    {
                        "type": "text",
                        "text": content_val,
                        "cache_control": cache_control,
                    }
                ]

    return params_messages


def convert_tools(
    tools: List[Tool],
    is_oauth: bool,
    supports_eager: bool,
    cache_control: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    converted = []
    for index, tool in enumerate(tools):
        schema = tool.get("parameters") or {}
        properties = schema.get("properties") or {}
        required = schema.get("required") or []

        t_spec: Dict[str, Any] = {
            "name": to_claude_code_name(tool.get("name", "")) if is_oauth else tool.get("name"),
            "description": tool.get("description", ""),
            "input_schema": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        }
        if supports_eager:
            t_spec["eager_input_streaming"] = True
        if cache_control and index == len(tools) - 1:
            t_spec["cache_control"] = cache_control
        converted.append(t_spec)
    return converted


def map_stop_reason(reason: str) -> StopReason:
    if reason == "end_turn":
        return "stop"
    if reason == "max_tokens":
        return "length"
    if reason == "tool_use":
        return "toolUse"
    if reason == "refusal":
        return "error"
    if reason == "pause_turn":
        return "stop"
    if reason == "stop_sequence":
        return "stop"
    if reason == "sensitive":
        return "error"
    return "error"


def build_params(
    model: Model,
    context: Context,
    is_oauth: bool,
    options: Optional[StreamOptions] = None,
) -> Dict[str, Any]:
    options_dict = options or {}
    cache_res = get_cache_control(model, options_dict.get("cacheRetention"))
    cache_control = cache_res.get("cacheControl")
    compat = get_anthropic_compat(model)

    params: Dict[str, Any] = {
        "model": model["id"],
        "messages": convert_messages(
            context.get("messages", []),
            model,
            is_oauth,
            cache_control,
            compat["allowEmptySignature"],
        ),
        "max_tokens": options_dict.get("maxTokens") or model.get("maxTokens", 4096),
        "stream": True,
    }

    # System prompt
    system_prompt = context.get("systemPrompt")
    if is_oauth:
        system_blocks = [
            {
                "type": "text",
                "text": "You are Claude Code, Anthropic's official CLI for Claude.",
            }
        ]
        if cache_control:
            system_blocks[0]["cache_control"] = cache_control
        if system_prompt:
            sys_block = {
                "type": "text",
                "text": sanitize_surrogates(system_prompt),
            }
            if cache_control:
                sys_block["cache_control"] = cache_control
            system_blocks.append(sys_block)
        params["system"] = system_blocks
    elif system_prompt:
        sys_block = {
            "type": "text",
            "text": sanitize_surrogates(system_prompt),
        }
        if cache_control:
            sys_block["cache_control"] = cache_control
        params["system"] = [sys_block]

    # Temperature
    thinking_enabled = options_dict.get("thinkingEnabled", False)
    if (
        options_dict.get("temperature") is not None
        and not thinking_enabled
        and compat["supportsTemperature"]
    ):
        params["temperature"] = options_dict.get("temperature")

    # Tools
    tools = context.get("tools") or []
    if tools:
        params["tools"] = convert_tools(
            tools,
            is_oauth,
            compat["supportsEagerToolInputStreaming"],
            cache_control if compat["supportsCacheControlOnTools"] else None,
        )

    # Extended thinking config
    if model.get("reasoning"):
        if thinking_enabled:
            display = options_dict.get("thinkingDisplay") or "summarized"
            force_adaptive = model.get("compat", {}).get("forceAdaptiveThinking") is True
            if force_adaptive:
                params["thinking"] = {"type": "adaptive", "display": display}
                effort = options_dict.get("effort")
                if effort and _supports_output_config():
                    params["output_config"] = {"effort": effort}
            else:
                params["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": options_dict.get("thinkingBudgetTokens") or 1024,
                    "display": display,
                }
        elif thinking_enabled is False:
            params["thinking"] = {"type": "disabled"}

    # Metadata
    metadata = options_dict.get("metadata")
    if metadata and isinstance(metadata, dict) and "user_id" in metadata:
        params["metadata"] = {"user_id": metadata["user_id"]}

    # Tool choice
    tool_choice = options_dict.get("toolChoice")
    if tool_choice:
        if isinstance(tool_choice, str):
            params["tool_choice"] = {"type": tool_choice}
        else:
            params["tool_choice"] = tool_choice

    return params


def stream_anthropic(
    model: Model,
    context: Context,
    options: Optional[StreamOptions] = None,
) -> AssistantMessageEventStream:
    event_stream = AssistantMessageEventStream()

    async def run() -> None:
        output: AssistantMessage = {
            "role": "assistant",
            "content": [],
            "api": model.get("api", "anthropic-messages"),
            "provider": model.get("provider", "anthropic"),
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

            if "client" in options_dict:
                client = options_dict["client"]
                is_oauth = False
            else:
                api_key = options_dict.get("apiKey")
                if not api_key:
                    raise ValueError(f"No API key for provider: {model.get('provider')}")

                copilot_headers = None
                if model.get("provider") == "github-copilot":
                    has_images = has_copilot_vision_input(context.get("messages", []))
                    copilot_headers = build_copilot_dynamic_headers(
                        {
                            "messages": context.get("messages", []),
                            "hasImages": has_images,
                        }
                    )

                cache_res = get_cache_control(model, options_dict.get("cacheRetention"))
                cache_session_id = (
                    options_dict.get("sessionId") if cache_res.get("retention") != "none" else None
                )

                created = create_client(
                    model,
                    api_key,
                    options_dict.get("interleavedThinking", True),
                    shouldUseFineGrainedToolStreamingBeta(model, context),
                    options_headers=options_dict.get("headers"),
                    dynamic_headers=copilot_headers,
                    session_id=cache_session_id,
                )
                client = created["client"]
                is_oauth = created["isOAuthToken"]

            params = build_params(model, context, is_oauth, cast(StreamOptions, options_dict))

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

            # Request call
            async_stream = await client.messages.create(
                **params,
                timeout=timeout,
            )

            # Trigger onResponse hook
            on_response = options_dict.get("onResponse")
            if on_response:
                res_headers: Dict[str, str] = {}
                # Extract headers if possible
                res = on_response({"status": 200, "headers": res_headers}, model)
                if asyncio.iscoroutine(res):
                    await res

            event_stream.push({"type": "start", "partial": output})

            blocks: List[Any] = cast(List[Any], output["content"])

            async for event in async_stream:
                ev_type = event.type

                if ev_type == "message_start":
                    msg = event.message
                    output["responseId"] = msg.id
                    usage = msg.usage
                    output["usage"]["input"] = usage.input_tokens or 0
                    output["usage"]["output"] = usage.output_tokens or 0
                    # Check cache tokens
                    output["usage"]["cacheRead"] = getattr(usage, "cache_read_input_tokens", 0) or 0
                    output["usage"]["cacheWrite"] = (
                        getattr(usage, "cache_creation_input_tokens", 0) or 0
                    )
                    output["usage"]["totalTokens"] = (
                        output["usage"]["input"]
                        + output["usage"]["output"]
                        + output["usage"]["cacheRead"]
                        + output["usage"]["cacheWrite"]
                    )
                    calculate_cost(model, output["usage"])

                elif ev_type == "content_block_start":
                    cb = event.content_block
                    idx = event.index
                    if cb.type == "text":
                        block = {"type": "text", "text": "", "index": idx}
                        blocks.append(block)
                        event_stream.push(
                            {
                                "type": "text_start",
                                "contentIndex": len(blocks) - 1,
                                "partial": output,
                            }
                        )
                    elif cb.type == "thinking":
                        block = {
                            "type": "thinking",
                            "thinking": "",
                            "thinkingSignature": "",
                            "index": idx,
                        }
                        blocks.append(block)
                        event_stream.push(
                            {
                                "type": "thinking_start",
                                "contentIndex": len(blocks) - 1,
                                "partial": output,
                            }
                        )
                    elif cb.type == "redacted_thinking":
                        block = {
                            "type": "thinking",
                            "thinking": "[Reasoning redacted]",
                            "thinkingSignature": cb.data,
                            "redacted": True,
                            "index": idx,
                        }
                        blocks.append(block)
                        event_stream.push(
                            {
                                "type": "thinking_start",
                                "contentIndex": len(blocks) - 1,
                                "partial": output,
                            }
                        )
                    elif cb.type == "tool_use":
                        block = {
                            "type": "toolCall",
                            "id": cb.id,
                            "name": (
                                from_claude_code_name(cb.name, context.get("tools"))
                                if is_oauth
                                else cb.name
                            ),
                            "arguments": cb.input or {},
                            "partialJson": "",
                            "index": idx,
                        }
                        blocks.append(block)
                        event_stream.push(
                            {
                                "type": "toolcall_start",
                                "contentIndex": len(blocks) - 1,
                                "partial": output,
                            }
                        )

                elif ev_type == "content_block_delta":
                    delta = event.delta
                    idx = event.index
                    target_block_idx = next(
                        (i for i, b in enumerate(blocks) if b.get("index") == idx), -1
                    )
                    if target_block_idx != -1:
                        block = blocks[target_block_idx]
                        d_type = delta.type
                        if d_type == "text_delta" and block.get("type") == "text":
                            block["text"] += delta.text
                            event_stream.push(
                                {
                                    "type": "text_delta",
                                    "contentIndex": target_block_idx,
                                    "delta": delta.text,
                                    "partial": output,
                                }
                            )
                        elif d_type == "thinking_delta" and block.get("type") == "thinking":
                            block["thinking"] += delta.thinking
                            event_stream.push(
                                {
                                    "type": "thinking_delta",
                                    "contentIndex": target_block_idx,
                                    "delta": delta.thinking,
                                    "partial": output,
                                }
                            )
                        elif d_type == "input_json_delta" and block.get("type") == "toolCall":
                            block["partialJson"] += delta.partial_json
                            block["arguments"] = parse_streaming_json(block["partialJson"])
                            event_stream.push(
                                {
                                    "type": "toolcall_delta",
                                    "contentIndex": target_block_idx,
                                    "delta": delta.partial_json,
                                    "partial": output,
                                }
                            )
                        elif d_type == "signature_delta" and block.get("type") == "thinking":
                            block["thinkingSignature"] = block.get(
                                "thinkingSignature", ""
                            ) + getattr(delta, "signature", "")

                elif ev_type == "content_block_stop":
                    idx = event.index
                    target_block_idx = next(
                        (i for i, b in enumerate(blocks) if b.get("index") == idx), -1
                    )
                    if target_block_idx != -1:
                        block = blocks[target_block_idx]
                        block.pop("index", None)
                        b_type = block.get("type")
                        if b_type == "text":
                            event_stream.push(
                                {
                                    "type": "text_end",
                                    "contentIndex": target_block_idx,
                                    "content": block["text"],
                                    "partial": output,
                                }
                            )
                        elif b_type == "thinking":
                            event_stream.push(
                                {
                                    "type": "thinking_end",
                                    "contentIndex": target_block_idx,
                                    "content": block["thinking"],
                                    "partial": output,
                                }
                            )
                        elif b_type == "toolCall":
                            block["arguments"] = parse_streaming_json(block["partialJson"])
                            block.pop("partialJson", None)
                            event_stream.push(
                                {
                                    "type": "toolcall_end",
                                    "contentIndex": target_block_idx,
                                    "toolCall": cast(ToolCall, block),
                                    "partial": output,
                                }
                            )

                elif ev_type == "message_delta":
                    delta = event.delta
                    if getattr(delta, "stop_reason", None):
                        output["stopReason"] = map_stop_reason(delta.stop_reason)
                    usage = event.usage
                    if usage:
                        if getattr(usage, "input_tokens", None) is not None:
                            output["usage"]["input"] = usage.input_tokens
                        if getattr(usage, "output_tokens", None) is not None:
                            output["usage"]["output"] = usage.output_tokens
                        if getattr(usage, "cache_read_input_tokens", None) is not None:
                            output["usage"]["cacheRead"] = usage.cache_read_input_tokens
                        if getattr(usage, "cache_creation_input_tokens", None) is not None:
                            output["usage"]["cacheWrite"] = usage.cache_creation_input_tokens
                        output["usage"]["totalTokens"] = (
                            output["usage"]["input"]
                            + output["usage"]["output"]
                            + output["usage"]["cacheRead"]
                            + output["usage"]["cacheWrite"]
                        )
                        calculate_cost(model, output["usage"])

            signal = options_dict.get("signal")
            if signal and getattr(signal, "aborted", False):
                raise ValueError("Request was aborted")

            if output.get("stopReason") in ("aborted", "error"):
                raise ValueError("An unknown error occurred")

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
            for blk in output["content"]:
                b = cast(Any, blk)
                b.pop("index", None)
                b.pop("partialJson", None)

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


def map_thinking_level_to_effort(model: Model, level: str) -> str:
    thinking_map = model.get("thinkingLevelMap") or {}
    mapped = thinking_map.get(cast(ModelThinkingLevel, level))
    if isinstance(mapped, str):
        return mapped

    if level in ("minimal", "low"):
        return "low"
    if level == "medium":
        return "medium"
    return "high"


def stream_simple_anthropic(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessageEventStream:
    options_dict = options or {}
    api_key = options_dict.get("apiKey")
    if not api_key:
        raise ValueError(f"No API key for provider: {model.get('provider')}")

    base = build_base_options(model, options, api_key)
    reasoning = options_dict.get("reasoning")
    if not reasoning:
        return stream_anthropic(
            model, context, cast(StreamOptions, {**base, "thinkingEnabled": False})
        )

    compat = model.get("compat") or {}
    if compat.get("forceAdaptiveThinking") is True:
        effort = map_thinking_level_to_effort(model, reasoning)
        return stream_anthropic(
            model,
            context,
            cast(
                StreamOptions,
                {
                    **base,
                    "thinkingEnabled": True,
                    "effort": effort,
                },
            ),
        )

    adjusted = adjust_max_tokens_for_thinking(
        base.get("maxTokens"),
        model.get("maxTokens", 4096),
        cast(ThinkingLevel, reasoning),
        cast(Optional[ThinkingBudgets], options_dict.get("thinkingBudgets")),
    )

    return stream_anthropic(
        model,
        context,
        cast(
            StreamOptions,
            {
                **base,
                "maxTokens": adjusted["maxTokens"],
                "thinkingEnabled": True,
                "thinkingBudgetTokens": adjusted["thinkingBudget"],
            },
        ),
    )
