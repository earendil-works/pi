from typing import Optional
from pi_mono.ai.images_api_registry import get_images_api_provider
from pi_mono.ai.types import AssistantImages, ImagesContext, ImagesModel, ImagesOptions

# Import to trigger registering built-ins side effects


def resolve_images_api_provider(api: str):
    provider = get_images_api_provider(api)
    if not provider:
        raise ValueError(f"No API provider registered for api: {api}")
    return provider


async def generate_images(
    model: ImagesModel,
    context: ImagesContext,
    options: Optional[ImagesOptions] = None,
) -> AssistantImages:
    """Generate images using the registered API provider for the model's api."""
    provider = resolve_images_api_provider(model["api"])
    return await provider.generate_images(model, context, options)
