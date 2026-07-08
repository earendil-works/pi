"""Built-in image API provider registration with lazy module loading."""

from __future__ import annotations

import importlib
from typing import Any

from pi_mono.ai.images_api_registry import get_images_api_provider, register_images_api_provider


def _make_lazy_images_provider(api_name: str, module_path: str, attr: str) -> Any:
    class LazyImagesProviderRegistration:
        api = api_name
        _module: Any = None

        def _load(self) -> Any:
            if self._module is None:
                self._module = importlib.import_module(module_path)
            return self._module

        async def generate_images(self, model: Any, context: Any, options: Any = None) -> Any:
            module = self._load()
            return await getattr(module, attr)(model, context, options)

    return LazyImagesProviderRegistration()


def register_built_in_images_api_providers() -> None:
    api = "openrouter-images"
    if get_images_api_provider(api) is not None:
        return
    register_images_api_provider(
        _make_lazy_images_provider(
            api,
            "pi_mono.ai.providers.images.openrouter",
            "generate_images_openrouter",
        )  # type: ignore[arg-type]
    )


register_built_in_images_api_providers()
