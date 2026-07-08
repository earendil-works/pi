from typing import cast

from pi_mono.ai.types import ImagesModel
from pi_mono.ai.image_models_generated import IMAGE_MODELS

image_model_registry: dict[str, dict[str, ImagesModel]] = {}

# Initialize registry
for provider, models in IMAGE_MODELS.items():
    image_model_registry[provider] = {id: cast(ImagesModel, m) for id, m in models.items()}


def get_image_model(provider: str, model_id: str) -> ImagesModel | None:
    provider_models = image_model_registry.get(provider)
    if provider_models is None:
        return None
    return provider_models.get(model_id)


def get_image_providers() -> list[str]:
    return list(image_model_registry.keys())


def get_image_models(provider: str) -> list[ImagesModel]:
    models = image_model_registry.get(provider)
    return list(models.values()) if models else []
