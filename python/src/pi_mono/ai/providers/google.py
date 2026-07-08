import asyncio
import re
import time
from typing import Any, Dict, Literal, Optional, TypedDict, cast

from google.genai import Client, types

from pi_mono.ai.models import calculate_cost, clamp_thinking_level
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    StreamOptions,
    TextContent,
    ThinkingBudgets,
    ThinkingContent,
    ToolCall,
)
from pi_mono.utils.event_stream import AssistantMessageEventStream
from pi_mono.utils.sanitize_unicode import sanitize_surrogates
from pi_mono.ai.providers.google_shared import (
    convert_messages,
    convert_tools,
    is_thinking_part,
    map_stop_reason,
    map_tool_choice,
    retain_thought_signature,
)
from pi_mono.ai.providers.simple_options import build_base_options

# Counter for generating unique tool call IDs
tool_call_counter = 0


class GoogleThinkingOptions(TypedDict, total=False):
    enabled: bool
    budgetTokens: int  # -1 for dynamic, 0 to disable
    level: types.ThinkingLevel


class GoogleOptions(StreamOptions, total=False):
    toolChoice: Literal["auto", "none", "any"]
    thinking: GoogleThinkingOptions


def stream_google(
    model: Model,
    context: Context,
    options: Optional[GoogleOptions] = None,
) -> AssistantMessageEventStream:
    event_stream = AssistantMessageEventStream()

    async def run() -> None:
        global tool_call_counter
        output: AssistantMessage = {
            "role": "assistant",
            "content": [],
            "api": "google-generative-ai",
            "provider": model.get("provider", "google"),
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
            options_dict = options or {}
            api_key = options_dict.get("apiKey")
            if not api_key:
                raise ValueError(f"No API key for provider: {model.get('provider')}")

            client = create_client(model, api_key, options_dict.get("headers"))
            params = build_params(model, context, options)

            on_payload = options_dict.get("onPayload")
            if on_payload:
                res = on_payload(params, model)
                if asyncio.iscoroutine(res):
                    res = await res
                if res is not None:
                    params = res

            google_stream = await client.aio.models.generate_content_stream(
                model=params["model"],
                contents=params["contents"],
                config=params["config"],
            )

            event_stream.push({"type": "start", "partial": output})
            current_block: Optional[Dict[str, Any]] = None
            blocks = output["content"]

            def get_block_index() -> int:
                return len(blocks) - 1

            async for chunk in google_stream:
                if chunk.response_id:
                    output["responseId"] = chunk.response_id

                candidates = chunk.candidates
                candidate = candidates[0] if (candidates and len(candidates) > 0) else None
                if candidate and candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        if part.text is not None:
                            is_thinking = is_thinking_part(part)
                            if (
                                not current_block
                                or (is_thinking and current_block.get("type") != "thinking")
                                or (not is_thinking and current_block.get("type") != "text")
                            ):
                                if current_block:
                                    if current_block.get("type") == "text":
                                        event_stream.push(
                                            {
                                                "type": "text_end",
                                                "contentIndex": get_block_index(),
                                                "content": current_block.get("text", ""),
                                                "partial": output,
                                            }
                                        )
                                    else:
                                        event_stream.push(
                                            {
                                                "type": "thinking_end",
                                                "contentIndex": get_block_index(),
                                                "content": current_block.get("thinking", ""),
                                                "partial": output,
                                            }
                                        )

                                if is_thinking:
                                    current_block = cast(
                                        Dict[str, Any],
                                        {
                                            "type": "thinking",
                                            "thinking": "",
                                            "thinkingSignature": None,
                                        },
                                    )
                                    blocks.append(cast(ThinkingContent, current_block))
                                    event_stream.push(
                                        {
                                            "type": "thinking_start",
                                            "contentIndex": get_block_index(),
                                            "partial": output,
                                        }
                                    )
                                else:
                                    current_block = cast(
                                        Dict[str, Any],
                                        {
                                            "type": "text",
                                            "text": "",
                                            "textSignature": None,
                                        },
                                    )
                                    blocks.append(cast(TextContent, current_block))
                                    event_stream.push(
                                        {
                                            "type": "text_start",
                                            "contentIndex": get_block_index(),
                                            "partial": output,
                                        }
                                    )

                            import base64

                            thought_sig_str = None
                            if part.thought_signature:
                                thought_sig_str = base64.b64encode(part.thought_signature).decode(
                                    "utf-8"
                                )

                            if current_block.get("type") == "thinking":
                                current_block["thinking"] += part.text
                                current_block["thinkingSignature"] = retain_thought_signature(
                                    current_block.get("thinkingSignature"), thought_sig_str
                                )
                                event_stream.push(
                                    {
                                        "type": "thinking_delta",
                                        "contentIndex": get_block_index(),
                                        "delta": part.text,
                                        "partial": output,
                                    }
                                )
                            else:
                                current_block["text"] += part.text
                                current_block["textSignature"] = retain_thought_signature(
                                    current_block.get("textSignature"), thought_sig_str
                                )
                                event_stream.push(
                                    {
                                        "type": "text_delta",
                                        "contentIndex": get_block_index(),
                                        "delta": part.text,
                                        "partial": output,
                                    }
                                )

                        if part.function_call:
                            if current_block:
                                if current_block.get("type") == "text":
                                    event_stream.push(
                                        {
                                            "type": "text_end",
                                            "contentIndex": get_block_index(),
                                            "content": current_block.get("text", ""),
                                            "partial": output,
                                        }
                                    )
                                else:
                                    event_stream.push(
                                        {
                                            "type": "thinking_end",
                                            "contentIndex": get_block_index(),
                                            "content": current_block.get("thinking", ""),
                                            "partial": output,
                                        }
                                    )
                                current_block = None

                            provided_id = part.function_call.id
                            needs_new_id = not provided_id or any(
                                b.get("type") == "toolCall" and b.get("id") == provided_id
                                for b in blocks
                            )
                            tool_call_id = cast(
                                str,
                                (
                                    f"{part.function_call.name}_{int(time.time())}_{tool_call_counter}"
                                    if needs_new_id
                                    else provided_id
                                ),
                            )
                            if needs_new_id:
                                tool_call_counter += 1

                            thought_sig_str = None
                            if part.thought_signature:
                                thought_sig_str = base64.b64encode(part.thought_signature).decode(
                                    "utf-8"
                                )

                            tool_call: ToolCall = {
                                "type": "toolCall",
                                "id": tool_call_id,
                                "name": part.function_call.name or "",
                                "arguments": cast(Dict[str, Any], part.function_call.args) or {},
                            }
                            if thought_sig_str:
                                tool_call["thoughtSignature"] = thought_sig_str

                            blocks.append(tool_call)
                            event_stream.push(
                                {
                                    "type": "toolcall_start",
                                    "contentIndex": get_block_index(),
                                    "partial": output,
                                }
                            )
                            event_stream.push(
                                {
                                    "type": "toolcall_delta",
                                    "contentIndex": get_block_index(),
                                    "delta": json.dumps(tool_call["arguments"]),
                                    "partial": output,
                                }
                            )
                            event_stream.push(
                                {
                                    "type": "toolcall_end",
                                    "contentIndex": get_block_index(),
                                    "toolCall": tool_call,
                                    "partial": output,
                                }
                            )

                if candidate and candidate.finish_reason:
                    output["stopReason"] = map_stop_reason(candidate.finish_reason)
                    if any(b.get("type") == "toolCall" for b in blocks):
                        output["stopReason"] = "toolUse"

                if chunk.usage_metadata:
                    prompt_tokens = chunk.usage_metadata.prompt_token_count or 0
                    cached_tokens = chunk.usage_metadata.cached_content_token_count or 0
                    cand_tokens = chunk.usage_metadata.candidates_token_count or 0
                    thought_tokens = chunk.usage_metadata.thoughts_token_count or 0

                    output["usage"] = {
                        "input": max(0, prompt_tokens - cached_tokens),
                        "output": cand_tokens + thought_tokens,
                        "cacheRead": cached_tokens,
                        "cacheWrite": 0,
                        "totalTokens": chunk.usage_metadata.total_token_count or 0,
                        "cost": {
                            "input": 0.0,
                            "output": 0.0,
                            "cacheRead": 0.0,
                            "cacheWrite": 0.0,
                            "total": 0.0,
                        },
                    }
                    calculate_cost(model, output["usage"])

            if current_block:
                if current_block.get("type") == "text":
                    event_stream.push(
                        {
                            "type": "text_end",
                            "contentIndex": get_block_index(),
                            "content": current_block.get("text", ""),
                            "partial": output,
                        }
                    )
                else:
                    event_stream.push(
                        {
                            "type": "thinking_end",
                            "contentIndex": get_block_index(),
                            "content": current_block.get("thinking", ""),
                            "partial": output,
                        }
                    )

            signal = options_dict.get("signal")
            if signal and getattr(signal, "aborted", False):
                raise ValueError("Request aborted")

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
            for block in output["content"]:
                b = cast(Dict[str, Any], block)
                b.pop("index", None)

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

    import json

    asyncio.create_task(run())
    return event_stream


def stream_simple_google(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessageEventStream:
    options_dict = options or {}
    api_key = options_dict.get("apiKey")
    if not api_key:
        raise ValueError(f"No API key for provider: {model.get('provider')}")

    base = build_base_options(model, options, api_key)
    if not options_dict.get("reasoning"):
        return stream_google(model, context, GoogleOptions(**base, thinking={"enabled": False}))

    clamped_reasoning = clamp_thinking_level(
        model,
        cast(
            Literal["off", "minimal", "low", "medium", "high", "xhigh"],
            options_dict["reasoning"],
        ),
    )
    effort = "high" if clamped_reasoning == "off" else clamped_reasoning

    if is_gemini3_pro_model(model) or is_gemini3_flash_model(model) or is_gemma4_model(model):
        return stream_google(
            model,
            context,
            GoogleOptions(
                **base,
                thinking={
                    "enabled": True,
                    "level": get_thinking_level(effort, model),
                },
            ),
        )

    return stream_google(
        model,
        context,
        GoogleOptions(
            **base,
            thinking={
                "enabled": True,
                "budgetTokens": get_google_budget(
                    model,
                    effort,
                    cast(Optional[ThinkingBudgets], options_dict.get("thinkingBudgets")),
                ),
            },
        ),
    )


def create_client(
    model: Model,
    api_key: Optional[str] = None,
    options_headers: Optional[Dict[str, str]] = None,
) -> Client:
    http_options: Dict[str, Any] = {}
    if model.get("baseUrl"):
        http_options["base_url"] = model["baseUrl"]
        http_options["api_version"] = ""

    headers = {**(model.get("headers") or {}), **(options_headers or {})}
    if headers:
        http_options["headers"] = headers

    return Client(
        api_key=api_key,
        http_options=types.HttpOptions(**http_options) if http_options else None,
    )


def build_params(
    model: Model,
    context: Context,
    options: Optional[GoogleOptions] = None,
) -> Dict[str, Any]:
    options_dict = options or {}
    contents = convert_messages(model, context)

    config_kwargs: Dict[str, Any] = {}
    if options_dict.get("temperature") is not None:
        config_kwargs["temperature"] = options_dict["temperature"]
    if options_dict.get("maxTokens") is not None:
        config_kwargs["max_output_tokens"] = options_dict["maxTokens"]

    if context.get("systemPrompt"):
        config_kwargs["system_instruction"] = sanitize_surrogates(context["systemPrompt"])

    tools = context.get("tools")
    if tools and len(tools) > 0:
        config_kwargs["tools"] = convert_tools(tools)

        tool_choice = options_dict.get("toolChoice")
        if tool_choice:
            config_kwargs["tool_config"] = types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=map_tool_choice(tool_choice)
                )
            )

    thinking = options_dict.get("thinking")
    is_reasoning_enabled = model.get("reasoning", False)

    if thinking and thinking.get("enabled") and is_reasoning_enabled:
        thinking_config = types.ThinkingConfig(include_thoughts=True)
        if thinking.get("level") is not None:
            thinking_config.thinking_level = thinking["level"]
        elif thinking.get("budgetTokens") is not None:
            thinking_config.thinking_budget = thinking["budgetTokens"]
        config_kwargs["thinking_config"] = thinking_config
    elif is_reasoning_enabled and thinking and not thinking.get("enabled"):
        config_kwargs["thinking_config"] = get_disabled_thinking_config(model)

    config = types.GenerateContentConfig(**config_kwargs)

    return {
        "model": model["id"],
        "contents": contents,
        "config": config,
    }


def is_gemma4_model(model: Model) -> bool:
    return bool(re.search(r"gemma-?4", model["id"].lower()))


def is_gemini3_pro_model(model: Model) -> bool:
    return bool(re.search(r"gemini-3(?:\.\d+)?-pro", model["id"].lower()))


def is_gemini3_flash_model(model: Model) -> bool:
    return bool(re.search(r"gemini-3(?:\.\d+)?-flash", model["id"].lower()))


def get_disabled_thinking_config(model: Model) -> types.ThinkingConfig:
    if is_gemini3_pro_model(model):
        return types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)
    if is_gemini3_flash_model(model):
        return types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL)
    if is_gemma4_model(model):
        return types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL)

    return types.ThinkingConfig(thinking_budget=0)


def get_thinking_level(effort: str, model: Model) -> types.ThinkingLevel:
    if is_gemini3_pro_model(model):
        if effort in ("minimal", "low"):
            return types.ThinkingLevel.LOW
        elif effort in ("medium", "high"):
            return types.ThinkingLevel.HIGH
    if is_gemma4_model(model):
        if effort in ("minimal", "low"):
            return types.ThinkingLevel.MINIMAL
        elif effort in ("medium", "high"):
            return types.ThinkingLevel.HIGH

    if effort == "minimal":
        return types.ThinkingLevel.MINIMAL
    elif effort == "low":
        return types.ThinkingLevel.LOW
    elif effort == "medium":
        return types.ThinkingLevel.MEDIUM
    elif effort == "high":
        return types.ThinkingLevel.HIGH
    return types.ThinkingLevel.THINKING_LEVEL_UNSPECIFIED


def get_google_budget(
    model: Model,
    effort: str,
    custom_budgets: Optional[ThinkingBudgets] = None,
) -> int:
    if custom_budgets and custom_budgets.get(effort) is not None:  # type: ignore
        return custom_budgets[effort]  # type: ignore

    model_id = model["id"]
    if "2.5-pro" in model_id:
        budgets = {
            "minimal": 128,
            "low": 2048,
            "medium": 8192,
            "high": 32768,
        }
        return budgets[effort]  # type: ignore

    if "2.5-flash-lite" in model_id:
        budgets = {
            "minimal": 512,
            "low": 2048,
            "medium": 8192,
            "high": 24576,
        }
        return budgets[effort]  # type: ignore

    if "2.5-flash" in model_id:
        budgets = {
            "minimal": 128,
            "low": 2048,
            "medium": 8192,
            "high": 24576,
        }
        return budgets[effort]  # type: ignore

    return -1
