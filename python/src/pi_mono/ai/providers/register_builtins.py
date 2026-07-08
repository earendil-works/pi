"""Built-in API provider registration with lazy module loading."""

from __future__ import annotations

import importlib
from typing import Any

from pi_mono.ai.api_registry import get_api_provider, register_api_provider


def _make_lazy_provider(
    api_name: str,
    module_path: str,
    stream_attr: str,
    stream_simple_attr: str,
) -> Any:
    class LazyProviderRegistration:
        api = api_name
        _module: Any = None

        def _load(self) -> Any:
            if self._module is None:
                self._module = importlib.import_module(module_path)
            return self._module

        def stream(self, model: Any, context: Any, options: Any = None) -> Any:
            module = self._load()
            return getattr(module, stream_attr)(model, context, options)

        def stream_simple(self, model: Any, context: Any, options: Any = None) -> Any:
            module = self._load()
            return getattr(module, stream_simple_attr)(model, context, options)

    return LazyProviderRegistration()


_LAZY_PROVIDERS: list[tuple[str, str, str, str]] = [
    (
        "anthropic-messages",
        "pi_mono.ai.providers.anthropic",
        "stream_anthropic",
        "stream_simple_anthropic",
    ),
    (
        "openai-completions",
        "pi_mono.ai.providers.openai_completions",
        "stream_openai_completions",
        "stream_simple_openai_completions",
    ),
    (
        "mistral-conversations",
        "pi_mono.ai.providers.mistral",
        "stream_mistral",
        "stream_simple_mistral",
    ),
    (
        "openai-responses",
        "pi_mono.ai.providers.openai_responses",
        "stream_openai_responses",
        "stream_simple_openai_responses",
    ),
    (
        "azure-openai-responses",
        "pi_mono.ai.providers.azure_openai_responses",
        "stream_azure_openai_responses",
        "stream_simple_azure_openai_responses",
    ),
    (
        "google-generative-ai",
        "pi_mono.ai.providers.google",
        "stream_google",
        "stream_simple_google",
    ),
    (
        "google-vertex",
        "pi_mono.ai.providers.google_vertex",
        "stream_google_vertex",
        "stream_simple_google_vertex",
    ),
    (
        "bedrock-converse-stream",
        "pi_mono.ai.providers.amazon_bedrock",
        "stream_bedrock",
        "stream_simple_bedrock",
    ),
    (
        "openai-codex-responses",
        "pi_mono.ai.providers.openai_codex_responses",
        "stream_openai_codex_responses",
        "stream_simple_openai_codex_responses",
    ),
]


def reset_api_providers() -> None:
    from pi_mono.ai.api_registry import clear_api_providers

    clear_api_providers()
    register_built_in_api_providers()


def register_built_in_api_providers() -> None:
    """Register lazy wrappers for built-in API providers."""
    for api, module_path, stream_attr, stream_simple_attr in _LAZY_PROVIDERS:
        if get_api_provider(api) is not None:
            continue
        register_api_provider(
            _make_lazy_provider(api, module_path, stream_attr, stream_simple_attr)  # type: ignore[arg-type]
        )


register_built_in_api_providers()
