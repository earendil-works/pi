from typing import Callable, Dict, List, Optional, Protocol, TypedDict
from pi_mono.ai.types import Context, Model, SimpleStreamOptions, StreamOptions
from pi_mono.utils.event_stream import AssistantMessageEventStream


class ApiProvider(Protocol):
    api: str

    def stream(
        self,
        model: Model,
        context: Context,
        options: Optional[StreamOptions] = None,
    ) -> AssistantMessageEventStream: ...

    def stream_simple(
        self,
        model: Model,
        context: Context,
        options: Optional[SimpleStreamOptions] = None,
    ) -> AssistantMessageEventStream: ...


class ApiProviderInternal:
    def __init__(
        self,
        api: str,
        stream: Callable[[Model, Context, Optional[StreamOptions]], AssistantMessageEventStream],
        stream_simple: Callable[
            [Model, Context, Optional[SimpleStreamOptions]], AssistantMessageEventStream
        ],
    ):
        self.api = api
        self.stream = stream
        self.stream_simple = stream_simple


class RegisteredApiProvider(TypedDict):
    provider: ApiProviderInternal
    sourceId: Optional[str]


_api_provider_registry: Dict[str, RegisteredApiProvider] = {}


def wrap_stream(
    api: str,
    stream_func: Callable[[Model, Context, Optional[StreamOptions]], AssistantMessageEventStream],
) -> Callable[[Model, Context, Optional[StreamOptions]], AssistantMessageEventStream]:
    def wrapper(
        model: Model, context: Context, options: Optional[StreamOptions] = None
    ) -> AssistantMessageEventStream:
        if model.get("api") != api:
            raise ValueError(f"Mismatched api: {model.get('api')} expected {api}")
        return stream_func(model, context, options)

    return wrapper


def wrap_stream_simple(
    api: str,
    stream_simple_func: Callable[
        [Model, Context, Optional[SimpleStreamOptions]], AssistantMessageEventStream
    ],
) -> Callable[[Model, Context, Optional[SimpleStreamOptions]], AssistantMessageEventStream]:
    def wrapper(
        model: Model, context: Context, options: Optional[SimpleStreamOptions] = None
    ) -> AssistantMessageEventStream:
        if model.get("api") != api:
            raise ValueError(f"Mismatched api: {model.get('api')} expected {api}")
        return stream_simple_func(model, context, options)

    return wrapper


def register_api_provider(provider: ApiProvider, source_id: Optional[str] = None) -> None:
    """Register a provider for a specific LLM API."""
    _api_provider_registry[provider.api] = {
        "provider": ApiProviderInternal(
            api=provider.api,
            stream=wrap_stream(provider.api, provider.stream),
            stream_simple=wrap_stream_simple(provider.api, provider.stream_simple),
        ),
        "sourceId": source_id,
    }


def get_api_provider(api: str) -> Optional[ApiProviderInternal]:
    """Retrieve the registered API provider wrapper for the given api string."""
    entry = _api_provider_registry.get(api)
    return entry["provider"] if entry else None


def get_api_providers() -> List[ApiProviderInternal]:
    """Get all registered API providers."""
    return [entry["provider"] for entry in _api_provider_registry.values()]


def unregister_api_providers(source_id: str) -> None:
    """Remove all API providers registered with the given source ID."""
    to_delete = [
        api for api, entry in _api_provider_registry.items() if entry.get("sourceId") == source_id
    ]
    for api in to_delete:
        _api_provider_registry.pop(api, None)


def clear_api_providers() -> None:
    """Clear all registered API providers."""
    _api_provider_registry.clear()
