"""OpenAI Responses API provider."""

import os
from openai import OpenAI

from pi_mono.ai.models import clamp_thinking_level
from pi_mono.ai.types import (
    Any,
    AssistantMessage,
    Context,
    Model,
    OpenAIResponsesCompat,
    SimpleStreamOptions,
    StreamOptions,
    Usage,
)
from pi_mono.ai.utils.event_stream import AssistantMessageEventStream
from pi_mono.ai.utils.headers import headers_to_record
from pi_mono.ai.providers.cloudflare import is_cloudflare_provider, resolve_cloudflare_base_url
from pi_mono.ai.providers.github_copilot_headers import (
    build_copilot_dynamic_headers,
    has_copilot_vision_input,
)
from pi_mono.ai.providers.openai_prompt_cache import clamp_openai_prompt_cache_key
from pi_mono.ai.providers.openai_responses_shared import (
    OpenAIResponsesStreamOptions,
    convert_responses_messages,
    convert_responses_tools,
    encode_text_signature_v1 as encode_text_signature_v1,
    parse_text_signature as parse_text_signature,
)
from pi_mono.ai.providers.simple_options import build_base_options

OPENAI_TOOL_CALL_PROVIDERS = {"openai", "openai-codex", "opencode"}


def resolve_cache_retention(cache_retention: str | None) -> str:
    if cache_retention:
        return cache_retention
    if os.environ.get("PI_CACHE_RETENTION") == "long":
        return "long"
    return "short"


def get_compat(model: Model[str]) -> OpenAIResponsesCompat:
    return {
        "sendSessionIdHeader": model.get("compat", {}).get("sendSessionIdHeader", True),
        "supportsLongCacheRetention": model.get("compat", {}).get(
            "supportsLongCacheRetention", True
        ),
    }


def get_prompt_cache_retention(compat: OpenAIResponsesCompat, cache_retention: str) -> str | None:
    return "24h" if cache_retention == "long" and compat.get("supportsLongCacheRetention") else None


def format_openai_responses_error(error: Exception) -> str:
    for attr in ("status_code", "status"):
        status = getattr(error, attr, None)
        if isinstance(status, int):
            return f"OpenAI API error ({status}): {error}"
    return str(error)


def _get_prompt_cache_retention(compat: OpenAIResponsesCompat, cache_retention: str) -> str | None:
    return "24h" if cache_retention == "long" and compat.get("supportsLongCacheRetention") else None


def _format_openai_responses_error(error: Exception) -> str:
    status = getattr(error, "status", None)
    if isinstance(status, int):
        return f"OpenAI API error ({status}): {error}"
    return str(error)


class OpenAIResponsesOptions:
    def __init__(
        self,
        reasoning_effort: str | None = None,
        reasoning_summary: str | None = None,
        service_tier: str | None = None,
        **kwargs,
    ):
        self.reasoning_effort = reasoning_effort
        self.reasoning_summary = reasoning_summary
        self.service_tier = service_tier
        for k, v in kwargs.items():
            setattr(self, k, v)


def _get_service_tier_cost_multiplier(model_id: str, service_tier: str | None) -> float:
    if service_tier == "flex":
        return 0.5
    if service_tier == "priority":
        return 2.5 if model_id == "gpt-5.5" else 2.0
    return 1.0


def _apply_service_tier_pricing(usage: Usage, service_tier: str | None, model_id: str) -> None:
    multiplier = _get_service_tier_cost_multiplier(model_id, service_tier)
    if multiplier == 1.0:
        return
    usage["cost"]["input"] *= multiplier
    usage["cost"]["output"] *= multiplier
    usage["cost"]["cacheRead"] *= multiplier
    usage["cost"]["cacheWrite"] *= multiplier
    usage["cost"]["total"] = (
        usage["cost"]["input"]
        + usage["cost"]["output"]
        + usage["cost"]["cacheRead"]
        + usage["cost"]["cost"]["cacheWrite"]
    )


def _create_client(
    model: Model[str],
    context: Context,
    api_key: str,
    options_headers: dict[str, str] | None = None,
    session_id: str | None = None,
) -> OpenAI:
    compat = get_compat(model)
    headers = {**model.get("headers", {})}

    if model["provider"] == "github-copilot":
        has_images = has_copilot_vision_input(context.get("messages", []))
        copilot_headers = build_copilot_dynamic_headers(
            {"messages": context["messages"], "hasImages": has_images}
        )
        headers.update(copilot_headers)

    if session_id:
        if compat.get("sendSessionIdHeader"):
            headers["session_id"] = session_id
        headers["x-client-request-id"] = session_id

    if options_headers:
        headers.update(options_headers)

    if model["provider"] == "cloudflare-ai-gateway":
        default_headers = {
            **headers,
            "Authorization": headers.get("Authorization"),
            "cf-aig-authorization": f"Bearer {api_key}",
        }
    else:
        default_headers = headers

    base_url = (
        resolve_cloudflare_base_url(model)
        if is_cloudflare_provider(model["provider"])
        else model.get("baseUrl")
    )

    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers=default_headers,
    )


def _build_params(
    model: Model[str],
    context: Context,
    options: OpenAIResponsesOptions | None = None,
) -> dict[str, Any]:
    from pi_mono.ai.providers.openai_responses_shared import ConvertResponsesMessagesOptions

    messages = convert_responses_messages(
        model, context, OPENAI_TOOL_CALL_PROVIDERS, ConvertResponsesMessagesOptions()
    )

    cache_retention = resolve_cache_retention(options.cache_retention if options else None)
    compat = get_compat(model)

    params: dict[str, Any] = {
        "model": model["id"],
        "input": messages,
        "stream": True,
        "prompt_cache_key": (
            None
            if cache_retention == "none"
            else clamp_openai_prompt_cache_key(options.session_id if options else None)
        ),
        "prompt_cache_retention": _get_prompt_cache_retention(compat, cache_retention),
        "store": False,
    }

    if options:
        if options.get("maxTokens"):
            params["max_output_tokens"] = options["maxTokens"]
        if options.get("temperature") is not None:
            params["temperature"] = options["temperature"]
        if options.get("serviceTier") is not None:
            params["service_tier"] = options["serviceTier"]

    if context.get("tools"):
        params["tools"] = convert_responses_tools(context["tools"])

    if model.get("reasoning"):
        reasoning_effort = options.reasoning_effort if options else None
        reasoning_summary = options.reasoning_summary if options else None
        if reasoning_effort or reasoning_summary:
            effort = reasoning_effort if reasoning_effort else "medium"
            params["reasoning"] = {
                "effort": effort,
                "summary": reasoning_summary or "auto",
            }
            params["include"] = ["reasoning.encrypted_content"]
        elif (
            model["provider"] != "github-copilot"
            and model.get("thinkingLevelMap", {}).get("off") is not None
        ):
            params["reasoning"] = {"effort": model["thinkingLevelMap"].get("off", "none")}

    return params


def stream_openai_responses(
    model: Model[str],
    context: Context,
    options: StreamOptions | None = None,
) -> AssistantMessageEventStream:
    from pi_mono.ai.providers.openai_responses_shared import process_responses_stream as prs

    stream = AssistantMessageEventStream()

    async def run() -> None:
        output: AssistantMessage = {
            "role": "assistant",
            "content": [],
            "api": model["api"],
            "provider": model["provider"],
            "model": model["id"],
            "usage": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 0,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            },
            "stopReason": "stop",
            "timestamp": int(__import__("time").time() * 1000),
        }

        try:
            api_key = options.get("apiKey") if options else None
            if not api_key:
                raise ValueError(f"No API key for provider: {model['provider']}")

            cache_retention = resolve_cache_retention(
                options.get("cacheRetention") if options else None
            )
            cache_session_id = (
                None if cache_retention == "none" else options.get("sessionId") if options else None
            )

            client = _create_client(
                model,
                context,
                api_key,
                options.get("headers") if options else None,
                cache_session_id,
            )
            params = _build_params(
                model, context, OpenAIResponsesOptions(**options) if options else None
            )

            next_params = (
                await options.get("onPayload", lambda p, m: None)(params, model)
                if options
                else None
            )
            if next_params is not None:
                params = next_params

            request_options = {}
            if options:
                if options.get("signal"):
                    request_options["signal"] = options["signal"]
                if options.get("timeoutMs") is not None:
                    request_options["timeout"] = options["timeoutMs"] / 1000
                request_options["max_retries"] = options.get("maxRetries", 0)

            response = await client.responses.create(**params, **request_options)
            (
                await options.get("onResponse", lambda r, m: None)(
                    {
                        "status": response.status,
                        "headers": headers_to_record(response.headers),
                    },
                    model,
                )
                if options
                else None
            )

            stream.push({"type": "start", "partial": output})

            await prs(
                response,
                output,
                stream,
                model,
                OpenAIResponsesStreamOptions(
                    service_tier=options.get("serviceTier") if options else None,
                    apply_service_tier_pricing=lambda u, st: _apply_service_tier_pricing(
                        u, st, model["id"]
                    ),
                ),
            )

            if options and options.get("signal", {}).get("aborted"):
                raise RuntimeError("Request was aborted")

            if output["stopReason"] in ("aborted", "error"):
                raise RuntimeError("An unknown error occurred")

            stream.push({"type": "done", "reason": output["stopReason"], "message": output})
            stream.end()

        except Exception as error:
            for block in output["content"]:
                block.pop("index", None)
                block.pop("partialJson", None)
            output["stopReason"] = (
                "aborted" if (options and options.get("signal", {}).get("aborted")) else "error"
            )
            output["errorMessage"] = _format_openai_responses_error(error)
            stream.push({"type": "error", "reason": output["stopReason"], "error": output})
            stream.end()

    import asyncio

    asyncio.create_task(run())
    return stream


def stream_simple_openai_responses(
    model: Model[str],
    context: Context,
    options: SimpleStreamOptions | None = None,
) -> AssistantMessageEventStream:
    api_key = options.get("apiKey") if options else None
    if not api_key:
        raise ValueError(f"No API key for provider: {model['provider']}")

    base = build_base_options(model, options, api_key)
    clamped_reasoning = (
        clamp_thinking_level(model, options["reasoning"])
        if options and options.get("reasoning")
        else None
    )
    reasoning_effort = None if clamped_reasoning == "off" else clamped_reasoning

    return stream_openai_responses(model, context, {**base, "reasoningEffort": reasoning_effort})


streamOpenAIResponses = stream_openai_responses
streamSimpleOpenAIResponses = stream_simple_openai_responses
