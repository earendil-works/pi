"""OpenRouter image generation provider."""

import re
from typing import Any, cast

from openai import OpenAI

from pi_mono.ai.types import (
    AssistantImages,
    ImagesContext,
    ImagesFunction,
    ImagesModel,
    ImagesOptions,
)
from pi_mono.ai.utils.sanitize_unicode import sanitize_surrogates


def create_client(
    model: ImagesModel,
    api_key: str,
    options_headers: dict[str, str] | None = None,
) -> OpenAI:
    return OpenAI(
        api_key=api_key,
        base_url=model.get("baseUrl"),
        default_headers={**model.get("headers", {}), **(options_headers or {})},
    )


def build_params(model: ImagesModel, context: ImagesContext) -> dict[str, Any]:
    content = []
    for item in context.get("input", []):
        if item["type"] == "text":
            content.append(
                {
                    "type": "text",
                    "text": sanitize_surrogates(item["text"]),
                }
            )
        else:  # image
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{item['mimeType']};base64,{item['data']}"},
                }
            )

    modalities = ["image"]
    if "text" in model.get("output", []):
        modalities.append("text")

    return cast(
        dict[str, Any],
        {
            "model": model["id"],
            "messages": [{"role": "user", "content": content}],
            "stream": False,
            "modalities": modalities,
        },
    )


def _usage_value(raw_usage: Any, key: str, default: Any = 0) -> Any:
    if isinstance(raw_usage, dict):
        return raw_usage.get(key, default)
    return getattr(raw_usage, key, default)


def parse_usage(raw_usage: Any, model: ImagesModel) -> dict[str, Any]:
    prompt_tokens = _usage_value(raw_usage, "prompt_tokens", 0)
    details = _usage_value(raw_usage, "prompt_tokens_details", {})
    if isinstance(details, dict):
        reported_cached = details.get("cached_tokens", 0)
        cache_write = details.get("cache_write_tokens", 0)
    else:
        reported_cached = getattr(details, "cached_tokens", 0)
        cache_write = getattr(details, "cache_write_tokens", 0)
    cache_read = max(0, reported_cached - cache_write) if cache_write > 0 else reported_cached
    input_tokens = max(0, prompt_tokens - cache_read - cache_write)
    output_tokens = _usage_value(raw_usage, "completion_tokens", 0)

    cost = model.get("cost", {})
    usage = {
        "input": input_tokens,
        "output": output_tokens,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "totalTokens": input_tokens + output_tokens + cache_read + cache_write,
        "cost": {
            "input": (cost.get("input", 0) / 1_000_000) * input_tokens,
            "output": (cost.get("output", 0) / 1_000_000) * output_tokens,
            "cacheRead": (cost.get("cacheRead", 0) / 1_000_000) * cache_read,
            "cacheWrite": (cost.get("cacheWrite", 0) / 1_000_000) * cache_write,
        },
    }
    usage["cost"]["total"] = sum(usage["cost"].values())
    return usage


async def generate_images_openrouter(
    model: ImagesModel,
    context: ImagesContext,
    options: ImagesOptions | None = None,
) -> AssistantImages:
    output: AssistantImages = {
        "api": model["api"],
        "provider": model["provider"],
        "model": model["id"],
        "output": [],
        "stopReason": "stop",
        "timestamp": int(__import__("time").time() * 1000),
    }

    try:
        api_key = options.get("apiKey") if options else None
        if not api_key:
            raise ValueError(f"No API key for provider: {model['provider']}")

        client = create_client(model, api_key, options.get("headers") if options else None)
        params = build_params(model, context)

        next_params = None
        if options:
            on_payload = options.get("onPayload")
            if on_payload:
                next_params = await on_payload(params, model)
        if next_params is not None:
            params = next_params

        request_options = {}
        if options:
            if options.get("signal"):
                request_options["signal"] = options["signal"]
            if options.get("timeoutMs") is not None:
                request_options["timeout"] = options["timeoutMs"] / 1000
            request_options["max_retries"] = options.get("maxRetries", 0)

        response = client.chat.completions.create(**params, **request_options)
        choices = response.choices

        output["responseId"] = response.id
        if response.usage:
            output["usage"] = cast(
                Any,
                parse_usage(response.usage.model_dump(), model),
            )

        if choices:
            choice = choices[0]
            if choice.message:
                if choice.message.content:
                    output["output"].append({"type": "text", "text": choice.message.content})
                for image in getattr(choice.message, "images", []) or []:
                    image_url = (
                        image.image_url
                        if isinstance(image.image_url, str)
                        else image.image_url.url if image.image_url else None
                    )
                    if image_url and image_url.startswith("data:"):
                        matches = re.match(r"^data:([^;]+);base64,(.+)$", image_url)
                        if matches:
                            output["output"].append(
                                {
                                    "type": "image",
                                    "mimeType": matches.group(1),
                                    "data": matches.group(2),
                                }
                            )

        return output

    except Exception as e:
        signal_aborted = False
        if options:
            signal = options.get("signal")
            if isinstance(signal, dict):
                signal_aborted = signal.get("aborted", False)
            elif hasattr(signal, "aborted"):
                signal_aborted = signal.aborted

        output["stopReason"] = "aborted" if signal_aborted else "error"
        output["errorMessage"] = str(e)
        return output


generateImagesOpenRouter: ImagesFunction = generate_images_openrouter
