from typing import Any, Callable, Dict, List, Optional, Protocol, TypedDict
from pi_mono.ai.types import ImagesContext, ImagesModel, ImagesOptions, AssistantImages


class ImagesApiProvider(Protocol):
    api: str

    async def generate_images(
        self,
        model: ImagesModel,
        context: ImagesContext,
        options: Optional[ImagesOptions] = None,
    ) -> AssistantImages: ...


class ImagesApiProviderInternal:
    def __init__(
        self,
        api: str,
        generate_images: Callable[[ImagesModel, ImagesContext, Optional[ImagesOptions]], Any],
    ):
        self.api = api
        self.generate_images = generate_images


class RegisteredImagesApiProvider(TypedDict):
    provider: ImagesApiProviderInternal
    sourceId: Optional[str]


_images_api_provider_registry: Dict[str, RegisteredImagesApiProvider] = {}


def wrap_generate_images(
    api: str,
    generate_images_func: Callable[[ImagesModel, ImagesContext, Optional[ImagesOptions]], Any],
) -> Callable[[ImagesModel, ImagesContext, Optional[ImagesOptions]], Any]:
    async def wrapper(
        model: ImagesModel, context: ImagesContext, options: Optional[ImagesOptions] = None
    ) -> AssistantImages:
        if model.get("api") != api:
            raise ValueError(f"Mismatched api: {model.get('api')} expected {api}")
        return await generate_images_func(model, context, options)

    return wrapper


def register_images_api_provider(
    provider: ImagesApiProvider, source_id: Optional[str] = None
) -> None:
    """Register a provider for a specific image generation API."""
    _images_api_provider_registry[provider.api] = {
        "provider": ImagesApiProviderInternal(
            api=provider.api,
            generate_images=wrap_generate_images(provider.api, provider.generate_images),
        ),
        "sourceId": source_id,
    }


def get_images_api_provider(api: str) -> Optional[ImagesApiProviderInternal]:
    """Retrieve the registered Images API provider wrapper for the given api string."""
    entry = _images_api_provider_registry.get(api)
    return entry["provider"] if entry else None


def get_images_api_providers() -> List[ImagesApiProviderInternal]:
    """Get all registered Images API providers."""
    return [entry["provider"] for entry in _images_api_provider_registry.values()]


def unregister_images_api_providers(source_id: str) -> None:
    """Remove all Images API providers registered with the given source ID."""
    keys_to_remove = [
        k for k, v in _images_api_provider_registry.items() if v.get("sourceId") == source_id
    ]
    for k in keys_to_remove:
        _images_api_provider_registry.pop(k, None)


def clear_images_api_providers() -> None:
    """Clear the registry."""
    _images_api_provider_registry.clear()
