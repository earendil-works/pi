import asyncio
import base64
import os
import re
import time
import urllib.parse
from typing import Any, Dict, List, Literal, Optional, cast

import boto3  # type: ignore[import-untyped]
import botocore.config  # type: ignore[import-untyped]
import botocore  # type: ignore[import-untyped]

from pi_mono.ai.models import calculate_cost
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    StopReason,
    StreamOptions,
    ThinkingBudgets,
    ThinkingLevel,
    Tool,
)
from pi_mono.utils.event_stream import AssistantMessageEventStream
from pi_mono.utils.json_parse import parse_streaming_json
from pi_mono.utils.node_http_proxy import create_http_proxy_agents_for_target
from pi_mono.utils.sanitize_unicode import sanitize_surrogates
from pi_mono.ai.providers.simple_options import (
    adjust_max_tokens_for_thinking,
    build_base_options,
    clamp_reasoning,
)
from pi_mono.ai.providers.transform_messages import transform_messages

BedrockThinkingDisplay = Literal["summarized", "omitted"]
EMPTY_TEXT_PLACEHOLDER = "<empty>"
GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials"


class BedrockOptions(StreamOptions, total=False):
    region: str
    profile: str
    toolChoice: Any  # "auto" | "any" | "none" | Dict[str, Any]
    reasoning: Optional[ThinkingLevel]
    thinkingBudgets: Optional[ThinkingBudgets]
    interleavedThinking: bool
    thinkingDisplay: BedrockThinkingDisplay
    requestMetadata: Dict[str, str]
    bearerToken: str


def normalize_tool_call_id(id_val: str, model: Model, assistant_msg: AssistantMessage) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", id_val)
    return sanitized[:64] if len(sanitized) > 64 else sanitized


def create_non_blank_text_block(text: str) -> Optional[Dict[str, str]]:
    sanitized = sanitize_surrogates(text)
    return None if len(sanitized.strip()) == 0 else {"text": sanitized}


def create_required_text_block(text: str) -> Dict[str, str]:
    return create_non_blank_text_block(text) or {"text": EMPTY_TEXT_PLACEHOLDER}


def convert_tool_result_content(content: List[Any]) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for c_val in content:
        c = cast(Dict[str, Any], c_val)
        if c.get("type") == "image":
            result.append({"image": create_image_block(c.get("mimeType", ""), c.get("data", ""))})
        else:
            text_block = create_non_blank_text_block(c.get("text", ""))
            if text_block:
                result.append(text_block)
    if not result:
        result.append({"text": EMPTY_TEXT_PLACEHOLDER})
    return result


def stream_bedrock(
    model: Model,
    context: Context,
    options: Optional[BedrockOptions] = None,
) -> AssistantMessageEventStream:
    event_stream = AssistantMessageEventStream()

    async def run() -> None:
        output: AssistantMessage = {
            "role": "assistant",
            "content": [],
            "api": "bedrock-converse-stream",
            "provider": model.get("provider", "amazon-bedrock"),
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

        blocks = output["content"]

        try:
            options_dict = cast(Dict[str, Any], options or {})

            session_kwargs = {}
            if options_dict.get("profile"):
                session_kwargs["profile_name"] = options_dict["profile"]

            session = boto3.Session(**session_kwargs)

            config_kwargs: Dict[str, Any] = {}
            configured_region = get_configured_bedrock_region(options_dict)
            has_configured_profile = has_configured_bedrock_profile()
            endpoint_region = get_standard_bedrock_endpoint_region(model.get("baseUrl"))
            use_explicit_endpoint = should_use_explicit_bedrock_endpoint(
                model.get("baseUrl"), configured_region, has_configured_profile
            )

            if configured_region:
                config_kwargs["region_name"] = configured_region
            elif endpoint_region and use_explicit_endpoint:
                config_kwargs["region_name"] = endpoint_region
            elif not has_configured_profile:
                config_kwargs["region_name"] = "us-east-1"

            proxy_config = create_http_proxy_agents_for_target(model.get("baseUrl") or "")
            if proxy_config:
                proxies = {"http": proxy_config.get("http"), "https": proxy_config.get("https")}
                config_kwargs["proxies"] = proxies

            botocore_config = botocore.config.Config(**config_kwargs)

            client_kwargs = {
                "service_name": "bedrock-runtime",
                "config": botocore_config,
            }
            if use_explicit_endpoint and model.get("baseUrl"):
                client_kwargs["endpoint_url"] = model["baseUrl"]

            client = session.client(**client_kwargs)

            bearer_token = options_dict.get("bearerToken") or os.environ.get(
                "AWS_BEARER_TOKEN_BEDROCK"
            )
            use_bearer_token = (
                bearer_token is not None and os.environ.get("AWS_BEDROCK_SKIP_AUTH") != "1"
            )

            if use_bearer_token:
                # Skip SigV4 signing
                client.meta.events.register(
                    "choose-signer.bedrock-runtime.*", lambda **kwargs: None
                )

                # Inject bearer token header
                def inject_token(request, **kwargs):
                    request.headers["Authorization"] = f"Bearer {bearer_token}"

                client.meta.events.register(
                    "before-send.bedrock-runtime.ConverseStream", inject_token
                )

            if options_dict.get("headers"):
                custom_headers = options_dict["headers"]

                def inject_custom_headers(request, **kwargs):
                    for k, v in custom_headers.items():
                        if not is_reserved_header(k):
                            request.headers[k] = v

                client.meta.events.register(
                    "before-send.bedrock-runtime.ConverseStream", inject_custom_headers
                )

            cache_retention = resolve_cache_retention(options_dict.get("cacheRetention"))
            inference_max_tokens = options_dict.get("maxTokens")
            if inference_max_tokens is None and is_anthropic_claude_model(model):
                inference_max_tokens = model.get("maxTokens")

            command_input: Dict[str, Any] = {
                "modelId": model["id"],
                "messages": convert_messages(context, model, cache_retention),
            }

            system_prompt = build_system_prompt(context.get("systemPrompt"), model, cache_retention)
            if system_prompt:
                command_input["system"] = system_prompt

            inference_config = {}
            if inference_max_tokens is not None:
                inference_config["maxTokens"] = inference_max_tokens
            if options_dict.get("temperature") is not None:
                inference_config["temperature"] = options_dict["temperature"]
            if inference_config:
                command_input["inferenceConfig"] = inference_config

            tool_config = convert_tool_config(context.get("tools"), options_dict.get("toolChoice"))
            if tool_config:
                command_input["toolConfig"] = tool_config

            add_fields = build_additional_model_request_fields(model, options_dict)
            if add_fields:
                command_input["additionalModelRequestFields"] = add_fields

            if options_dict.get("requestMetadata") is not None:
                command_input["requestMetadata"] = options_dict["requestMetadata"]

            on_payload = options_dict.get("onPayload")
            if on_payload:
                res = on_payload(command_input, model)
                if asyncio.iscoroutine(res):
                    res = await res
                if res is not None:
                    command_input = res

            def fetch_stream():
                return client.converse_stream(**command_input)

            response = await asyncio.to_thread(fetch_stream)

            on_response = options_dict.get("onResponse")
            if on_response:
                status_code = response.get("ResponseMetadata", {}).get("HTTPStatusCode", 200)
                request_id = response.get("ResponseMetadata", {}).get("RequestId")
                headers = {}
                if request_id:
                    headers["x-amzn-requestid"] = request_id
                res = on_response({"status": status_code, "headers": headers}, model)
                if asyncio.iscoroutine(res):
                    await res

            stream_iterator = response.get("stream")
            if not stream_iterator:
                raise ValueError("No stream in response")

            while True:
                event = await asyncio.to_thread(lambda: next(stream_iterator, None))
                if event is None:
                    break

                if "messageStart" in event:
                    if event["messageStart"].get("role") != "assistant":
                        raise ValueError(
                            "Unexpected assistant message start but got user message start instead"
                        )
                    event_stream.push({"type": "start", "partial": output})

                elif "contentBlockStart" in event:
                    handle_content_block_start(
                        event["contentBlockStart"], blocks, output, event_stream
                    )

                elif "contentBlockDelta" in event:
                    handle_content_block_delta(
                        event["contentBlockDelta"], blocks, output, event_stream
                    )

                elif "contentBlockStop" in event:
                    handle_content_block_stop(
                        event["contentBlockStop"], blocks, output, event_stream
                    )

                elif "messageStop" in event:
                    output["stopReason"] = map_stop_reason(event["messageStop"].get("stopReason"))

                elif "metadata" in event:
                    handle_metadata(event["metadata"], model, output)

                elif "internalServerException" in event:
                    raise ValueError(f"InternalServerException: {event['internalServerException']}")
                elif "modelStreamErrorException" in event:
                    raise ValueError(
                        f"ModelStreamErrorException: {event['modelStreamErrorException']}"
                    )
                elif "validationException" in event:
                    raise ValueError(f"ValidationException: {event['validationException']}")
                elif "throttlingException" in event:
                    raise ValueError(f"ThrottlingException: {event['throttlingException']}")
                elif "serviceUnavailableException" in event:
                    raise ValueError(
                        f"ServiceUnavailableException: {event['serviceUnavailableException']}"
                    )

            signal = options_dict.get("signal")
            if signal and getattr(signal, "aborted", False):
                raise ValueError("Request was aborted")

            if output.get("stopReason") in ("error", "aborted"):
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
            for block in output["content"]:
                b = cast(Dict[str, Any], block)
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


RESERVED_HEADER_EXACT = {"authorization", "host"}


def is_reserved_header(key: str) -> bool:
    lower = key.lower()
    return lower.startswith("x-amz-") or lower in RESERVED_HEADER_EXACT


def stream_simple_bedrock(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessageEventStream:
    options_dict = options or {}
    base = build_base_options(model, options, None)
    if not options_dict.get("reasoning"):
        return stream_bedrock(model, context, BedrockOptions(**base, reasoning=None))

    if is_anthropic_claude_model(model):
        if supports_adaptive_thinking(model["id"], model.get("name")):
            return stream_bedrock(
                model,
                context,
                BedrockOptions(
                    **base,
                    reasoning=cast(ThinkingLevel, options_dict["reasoning"]),
                    thinkingBudgets=cast(ThinkingBudgets, options_dict.get("thinkingBudgets")),
                ),
            )

        adjusted = adjust_max_tokens_for_thinking(
            base.get("maxTokens"),
            model.get("maxTokens") or 4096,
            cast(ThinkingLevel, options_dict["reasoning"]),
            cast(ThinkingBudgets, options_dict.get("thinkingBudgets")),
        )

        clamped = clamp_reasoning(cast(ThinkingLevel, options_dict["reasoning"]))
        budgets = dict(options_dict.get("thinkingBudgets") or {})
        if clamped:
            budgets[clamped] = adjusted["thinkingBudget"]

        return stream_bedrock(
            model,
            context,
            BedrockOptions(
                **base,
                maxTokens=adjusted["maxTokens"],
                reasoning=cast(ThinkingLevel, options_dict["reasoning"]),
                thinkingBudgets=cast(ThinkingBudgets, budgets),
            ),
        )

    return stream_bedrock(
        model,
        context,
        BedrockOptions(
            **base,
            reasoning=cast(ThinkingLevel, options_dict["reasoning"]),
            thinkingBudgets=cast(ThinkingBudgets, options_dict.get("thinkingBudgets")),
        ),
    )


def handle_content_block_start(
    event: Dict[str, Any],
    blocks: List[Any],
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
) -> None:
    index = event.get("contentBlockIndex", 0)
    start = event.get("start")
    if start and "toolUse" in start:
        tool_use = start["toolUse"]
        block = {
            "type": "toolCall",
            "id": tool_use.get("toolUseId") or "",
            "name": tool_use.get("name") or "",
            "arguments": {},
            "partialJson": "",
            "index": index,
        }
        output["content"].append(block)  # type: ignore
        stream.push(
            {
                "type": "toolcall_start",
                "contentIndex": len(blocks) - 1,
                "partial": output,
            }
        )


def handle_content_block_delta(
    event: Dict[str, Any],
    blocks: List[Any],
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
) -> None:
    content_block_index = event.get("contentBlockIndex", 0)
    delta = event.get("delta")
    if not delta:
        return

    idx = -1
    for i, b in enumerate(blocks):
        if b.get("index") == content_block_index:
            idx = i
            break
    block = blocks[idx] if idx != -1 else None

    if "text" in delta:
        text_val = delta["text"]
        if not block:
            new_block = {
                "type": "text",
                "text": "",
                "index": content_block_index,
            }
            output["content"].append(new_block)  # type: ignore
            idx = len(blocks) - 1
            block = blocks[idx]
            stream.push(
                {
                    "type": "text_start",
                    "contentIndex": idx,
                    "partial": output,
                }
            )
        if block.get("type") == "text":
            block["text"] = block.get("text", "") + text_val
            stream.push(
                {
                    "type": "text_delta",
                    "contentIndex": idx,
                    "delta": text_val,
                    "partial": output,
                }
            )

    elif "toolUse" in delta and block and block.get("type") == "toolCall":
        tool_use_val = delta["toolUse"]
        block["partialJson"] = block.get("partialJson", "") + (tool_use_val.get("input") or "")
        block["arguments"] = parse_streaming_json(block["partialJson"])
        stream.push(
            {
                "type": "toolcall_delta",
                "contentIndex": idx,
                "delta": tool_use_val.get("input") or "",
                "partial": output,
            }
        )

    elif "reasoningContent" in delta:
        reasoning_content = delta["reasoningContent"]
        thinking_block = block
        thinking_idx = idx

        if not thinking_block:
            new_block = {
                "type": "thinking",
                "thinking": "",
                "thinkingSignature": "",
                "index": content_block_index,
            }
            output["content"].append(new_block)  # type: ignore
            thinking_idx = len(blocks) - 1
            thinking_block = blocks[thinking_idx]
            stream.push(
                {
                    "type": "thinking_start",
                    "contentIndex": thinking_idx,
                    "partial": output,
                }
            )

        if thinking_block and thinking_block.get("type") == "thinking":
            if "text" in reasoning_content:
                text_val = reasoning_content["text"]
                thinking_block["thinking"] = thinking_block.get("thinking", "") + text_val
                stream.push(
                    {
                        "type": "thinking_delta",
                        "contentIndex": thinking_idx,
                        "delta": text_val,
                        "partial": output,
                    }
                )
            if "signature" in reasoning_content:
                thinking_block["thinkingSignature"] = (
                    thinking_block.get("thinkingSignature", "") + reasoning_content["signature"]
                )


def handle_content_block_stop(
    event: Dict[str, Any],
    blocks: List[Any],
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
) -> None:
    content_block_index = event.get("contentBlockIndex", 0)
    idx = -1
    for i, b in enumerate(blocks):
        if b.get("index") == content_block_index:
            idx = i
            break
    if idx == -1:
        return
    block = blocks[idx]
    block.pop("index", None)

    b_type = block.get("type")
    if b_type == "text":
        stream.push(
            {
                "type": "text_end",
                "contentIndex": idx,
                "content": block.get("text", ""),
                "partial": output,
            }
        )
    elif b_type == "thinking":
        stream.push(
            {
                "type": "thinking_end",
                "contentIndex": idx,
                "content": block.get("thinking", ""),
                "partial": output,
            }
        )
    elif b_type == "toolCall":
        block["arguments"] = parse_streaming_json(block.get("partialJson"))
        block.pop("partialJson", None)
        stream.push(
            {
                "type": "toolcall_end",
                "contentIndex": idx,
                "toolCall": block,
                "partial": output,
            }
        )


def handle_metadata(
    event: Dict[str, Any],
    model: Model,
    output: AssistantMessage,
) -> None:
    usage_val = event.get("usage")
    if usage_val:
        output["usage"]["input"] = usage_val.get("inputTokens") or 0
        output["usage"]["output"] = usage_val.get("outputTokens") or 0
        output["usage"]["cacheRead"] = usage_val.get("cacheReadInputTokens") or 0
        output["usage"]["cacheWrite"] = usage_val.get("cacheWriteInputTokens") or 0
        output["usage"]["totalTokens"] = usage_val.get("totalTokens") or (
            output["usage"]["input"] + output["usage"]["output"]
        )
        calculate_cost(model, output["usage"])


def get_model_match_candidates(model_id: str, model_name: Optional[str]) -> List[str]:
    values = [model_id, model_name] if model_name else [model_id]
    res = []
    for val in values:
        lower = val.lower()
        res.append(lower)
        res.append(re.sub(r"[\s_.:]+", "-", lower))
    return res


def supports_adaptive_thinking(model_id: str, model_name: Optional[str]) -> bool:
    candidates = get_model_match_candidates(model_id, model_name)
    return any(
        "opus-4-6" in s or "opus-4-7" in s or "opus-4-8" in s or "sonnet-4-6" in s
        for s in candidates
    )


def supports_native_xhigh_effort(model: Model) -> bool:
    candidates = get_model_match_candidates(model["id"], model.get("name"))
    return any("opus-4-7" in s or "opus-4-8" in s for s in candidates)


def map_thinking_level_to_effort(
    model: Model,
    level: Optional[str],
) -> str:
    if level == "xhigh" and supports_native_xhigh_effort(model):
        return "xhigh"

    thinking_level_map = model.get("thinkingLevelMap") or {}
    mapped = thinking_level_map.get(cast(Any, level)) if level else None
    if isinstance(mapped, str):
        return mapped

    if level in ("minimal", "low"):
        return "low"
    elif level == "medium":
        return "medium"
    return "high"


def resolve_cache_retention(cache_retention: Optional[str] = None) -> str:
    if cache_retention:
        return cache_retention
    if os.environ.get("PI_CACHE_RETENTION") == "long":
        return "long"
    return "short"


def is_anthropic_claude_model(model: Model) -> bool:
    model_id = model["id"].lower()
    model_name = model.get("name", "").lower()
    return (
        "anthropic.claude" in model_id
        or "anthropic/claude" in model_id
        or "anthropic.claude" in model_name
        or "anthropic/claude" in model_name
        or "claude" in model_name
    )


def supports_prompt_caching(model: Model) -> bool:
    candidates = get_model_match_candidates(model["id"], model.get("name"))
    has_claude_ref = any("claude" in s for s in candidates)
    if not has_claude_ref:
        if os.environ.get("AWS_BEDROCK_FORCE_CACHE") == "1":
            return True
        return False

    if any("-4-" in s for s in candidates):
        return True
    if any("claude-3-7-sonnet" in s for s in candidates):
        return True
    if any("claude-3-5-haiku" in s for s in candidates):
        return True
    return False


def supports_thinking_signature(model: Model) -> bool:
    return is_anthropic_claude_model(model)


def build_system_prompt(
    system_prompt: Optional[str],
    model: Model,
    cache_retention: str,
) -> Optional[List[Dict[str, Any]]]:
    if not system_prompt:
        return None

    blocks: List[Dict[str, Any]] = [{"text": sanitize_surrogates(system_prompt)}]

    if cache_retention != "none" and supports_prompt_caching(model):
        blocks.append(
            {
                "cachePoint": {
                    "type": "default",
                    **({"ttl": "oneHour"} if cache_retention == "long" else {}),
                }
            }
        )

    return blocks


def convert_messages(
    context: Context,
    model: Model,
    cache_retention: str,
) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []

    transformed_messages = transform_messages(
        context.get("messages", []), model, normalize_tool_call_id
    )

    i = 0
    while i < len(transformed_messages):
        msg = transformed_messages[i]
        role = msg.get("role")
        content_val = msg.get("content")

        if role == "user":
            user_content_blocks: List[Dict[str, Any]] = []
            if isinstance(content_val, str):
                user_content_blocks.append(create_required_text_block(content_val))
            else:
                for c_val in content_val or []:
                    c = cast(Dict[str, Any], c_val)
                    c_type = c.get("type")
                    if c_type == "text":
                        text_block = create_non_blank_text_block(c.get("text", ""))
                        if text_block:
                            user_content_blocks.append(text_block)
                    elif c_type == "image":
                        user_content_blocks.append(
                            {"image": create_image_block(c.get("mimeType", ""), c.get("data", ""))}
                        )
                if not user_content_blocks:
                    user_content_blocks.append({"text": EMPTY_TEXT_PLACEHOLDER})
            result.append(
                {
                    "role": "user",
                    "content": user_content_blocks,
                }
            )
            i += 1
        elif role == "assistant":
            if not content_val or len(content_val) == 0:
                i += 1
                continue
            assistant_content_blocks: List[Dict[str, Any]] = []
            content_list = cast(List[Any], content_val) if isinstance(content_val, list) else []
            for c_val in content_list:
                c = cast(Dict[str, Any], c_val)
                c_type = c.get("type")
                if c_type == "text":
                    text_block = create_non_blank_text_block(c.get("text", ""))
                    if text_block:
                        assistant_content_blocks.append(text_block)
                elif c_type == "toolCall":
                    assistant_content_blocks.append(
                        {
                            "toolUse": {
                                "toolUseId": c.get("id"),
                                "name": c.get("name"),
                                "input": c.get("arguments") or {},
                            }
                        }
                    )
                elif c_type == "thinking":
                    thinking_text = sanitize_surrogates(c.get("thinking", ""))
                    if len(thinking_text.strip()) == 0:
                        continue
                    if supports_thinking_signature(model):
                        thinking_sig = c.get("thinkingSignature")
                        if not thinking_sig or len(thinking_sig.strip()) == 0:
                            assistant_content_blocks.append({"text": thinking_text})
                        else:
                            assistant_content_blocks.append(
                                {
                                    "reasoningContent": {
                                        "reasoningText": {
                                            "text": thinking_text,
                                            "signature": thinking_sig,
                                        }
                                    }
                                }
                            )
                    else:
                        assistant_content_blocks.append(
                            {"reasoningContent": {"reasoningText": {"text": thinking_text}}}
                        )
            if not assistant_content_blocks:
                i += 1
                continue
            result.append(
                {
                    "role": "assistant",
                    "content": assistant_content_blocks,
                }
            )
            i += 1
        elif role == "toolResult":
            tool_results = []

            tool_results.append(
                {
                    "toolResult": {
                        "toolUseId": msg.get("toolCallId"),
                        "content": convert_tool_result_content(
                            cast(List[Any], msg.get("content") or [])
                        ),
                        "status": "error" if msg.get("isError") else "success",
                    }
                }
            )

            j = i + 1
            while (
                j < len(transformed_messages)
                and transformed_messages[j].get("role") == "toolResult"
            ):
                next_msg = transformed_messages[j]
                tool_results.append(
                    {
                        "toolResult": {
                            "toolUseId": next_msg.get("toolCallId"),
                            "content": convert_tool_result_content(
                                cast(List[Any], next_msg.get("content") or [])
                            ),
                            "status": "error" if next_msg.get("isError") else "success",
                        }
                    }
                )
                j += 1

            i = j

            result.append(
                {
                    "role": "user",
                    "content": tool_results,
                }
            )
        else:
            i += 1

    if cache_retention != "none" and supports_prompt_caching(model) and len(result) > 0:
        last_message = result[-1]
        if last_message.get("role") == "user" and last_message.get("content"):
            cast(List[Any], last_message["content"]).append(
                {
                    "cachePoint": {
                        "type": "default",
                        **({"ttl": "oneHour"} if cache_retention == "long" else {}),
                    }
                }
            )

    return result


def convert_tool_config(
    tools: Optional[List[Tool]],
    tool_choice: Any,
) -> Optional[Dict[str, Any]]:
    if not tools or len(tools) == 0 or tool_choice == "none":
        return None

    bedrock_tools = []
    for tool in tools:
        bedrock_tools.append(
            {
                "toolSpec": {
                    "name": tool.get("name"),
                    "description": tool.get("description"),
                    "inputSchema": {"json": tool.get("parameters") or {}},
                }
            }
        )

    bedrock_tool_choice = None
    if tool_choice == "auto":
        bedrock_tool_choice = {"auto": {}}
    elif tool_choice == "any":
        bedrock_tool_choice = {"any": {}}
    elif isinstance(tool_choice, dict) and tool_choice.get("type") == "tool":
        bedrock_tool_choice = {"tool": {"name": tool_choice.get("name")}}

    res: Dict[str, Any] = {"tools": bedrock_tools}
    if bedrock_tool_choice:
        res["toolChoice"] = bedrock_tool_choice
    return res


def map_stop_reason(reason: Optional[str]) -> StopReason:
    if reason in ("endTurn", "stopSequence"):
        return "stop"
    elif reason in ("maxTokens", "modelContextWindowExceeded"):
        return "length"
    elif reason == "toolUse":
        return "toolUse"
    return "error"


def get_configured_bedrock_region(options_dict: Dict[str, Any]) -> Optional[str]:
    return (
        options_dict.get("region")
        or os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
    )


def has_configured_bedrock_profile() -> bool:
    return bool(os.environ.get("AWS_PROFILE"))


def get_standard_bedrock_endpoint_region(base_url: Optional[str]) -> Optional[str]:
    if not base_url:
        return None
    try:
        url = urllib.parse.urlsplit(base_url)
        match = re.match(
            r"^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$",
            url.hostname.lower() if url.hostname else "",
        )
        return match.group(1) if match else None
    except Exception:
        return None


def should_use_explicit_bedrock_endpoint(
    base_url: Optional[str],
    configured_region: Optional[str],
    has_configured_profile: bool,
) -> bool:
    if not base_url:
        return False
    endpoint_region = get_standard_bedrock_endpoint_region(base_url)
    if not endpoint_region:
        return True
    return not configured_region and not has_configured_profile


def is_gov_cloud_bedrock_target(
    model: Model,
    options_dict: Dict[str, Any],
) -> bool:
    region = get_configured_bedrock_region(options_dict)
    if region and region.lower().startswith("us-gov-"):
        return True
    model_id = model["id"].lower()
    return model_id.startswith("us-gov.") or model_id.startswith("arn:aws-us-gov:")


def build_additional_model_request_fields(
    model: Model,
    options_dict: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    if not options_dict.get("reasoning") or not model.get("reasoning"):
        return None

    if is_anthropic_claude_model(model):
        display = (
            None
            if is_gov_cloud_bedrock_target(model, options_dict)
            else options_dict.get("thinkingDisplay", "summarized")
        )
        if supports_adaptive_thinking(model["id"], model.get("name")):
            result: Dict[str, Any] = {
                "thinking": {"type": "adaptive", **({"display": display} if display else {})},
                "output_config": {
                    "effort": map_thinking_level_to_effort(model, options_dict.get("reasoning"))
                },
            }
        else:
            default_budgets: Dict[str, int] = {
                "minimal": 1024,
                "low": 2048,
                "medium": 8192,
                "high": 16384,
                "xhigh": 16384,
            }
            level = options_dict["reasoning"]
            if level == "xhigh":
                level = "high"
            custom_budgets = options_dict.get("thinkingBudgets") or {}
            budget = custom_budgets.get(level) or default_budgets.get(
                options_dict["reasoning"], 16384
            )

            result = {
                "thinking": {
                    "type": "enabled",
                    "budget_tokens": budget,
                    **({"display": display} if display else {}),
                }
            }

        if not supports_adaptive_thinking(model["id"], model.get("name")) and options_dict.get(
            "interleavedThinking", True
        ):
            result["anthropic_beta"] = ["interleaved-thinking-2025-05-14"]

        return result

    return None


def create_image_block(
    mime_type: str,
    data: str,
) -> Dict[str, Any]:
    m = mime_type.lower()
    if m in ("image/jpeg", "image/jpg"):
        fmt = "jpeg"
    elif m == "image/png":
        fmt = "png"
    elif m == "image/gif":
        fmt = "gif"
    elif m == "image/webp":
        fmt = "webp"
    else:
        raise ValueError(f"Unknown image type: {mime_type}")

    img_bytes = base64.b64decode(data)
    return {"source": {"bytes": img_bytes}, "format": fmt}
