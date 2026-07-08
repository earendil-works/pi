from typing import Any, Optional, cast
import pi_mono.ai.providers.register_builtins  # noqa: F401
from pi_mono.ai.api_registry import get_api_provider
from pi_mono.ai.env_api_keys import get_env_api_key
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    StreamOptions,
)
from pi_mono.utils.event_stream import AssistantMessageEventStream


def _has_explicit_api_key(api_key: Optional[str]) -> bool:
    return isinstance(api_key, str) and len(api_key.strip()) > 0


def _with_env_api_key(model: Model, options: Optional[Any]) -> Optional[Any]:
    if options is not None and _has_explicit_api_key(options.get("apiKey")):
        return options
    provider = model.get("provider")
    if not provider:
        return options
    key = get_env_api_key(provider)
    if not key:
        return options
    new_options = dict(options) if options is not None else {}
    new_options["apiKey"] = key
    return new_options


def _resolve_api_provider(api: str) -> Any:
    provider = get_api_provider(api)
    if not provider:
        raise ValueError(f"No API provider registered for api: {api}")
    return provider


def stream(
    model: Model,
    context: Context,
    options: Optional[StreamOptions] = None,
) -> AssistantMessageEventStream:
    """Stream events from an LLM model."""
    provider_name = model.get("provider")
    if provider_name == "cursor":
        from pi_mono.ai.providers.cursor import stream_cursor

        resolved_options = _with_env_api_key(model, options)
        return stream_cursor(model, context, resolved_options)

    api = model.get("api", "")
    provider = _resolve_api_provider(api)
    resolved_options = _with_env_api_key(model, options)
    return cast(AssistantMessageEventStream, provider.stream(model, context, resolved_options))


async def complete(
    model: Model,
    context: Context,
    options: Optional[StreamOptions] = None,
) -> AssistantMessage:
    """Run an LLM model to completion, returning the final AssistantMessage."""
    s = stream(model, context, options)
    return await s.result()


def stream_simple(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessageEventStream:
    """Stream events from an LLM model using simple/basic options."""
    provider_name = model.get("provider")
    if provider_name == "cursor":
        from pi_mono.ai.providers.cursor import stream_simple_cursor

        resolved_options = _with_env_api_key(model, options)
        return stream_simple_cursor(model, context, resolved_options)

    api = model.get("api", "")
    provider = _resolve_api_provider(api)
    resolved_options = _with_env_api_key(model, options)
    return cast(
        AssistantMessageEventStream, provider.stream_simple(model, context, resolved_options)
    )


async def complete_simple(
    model: Model,
    context: Context,
    options: Optional[SimpleStreamOptions] = None,
) -> AssistantMessage:
    """Run an LLM model to completion using simple/basic options, returning the final AssistantMessage."""
    s = stream_simple(model, context, options)
    return await s.result()
