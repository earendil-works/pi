"""List available models with optional fuzzy search."""

from __future__ import annotations

import sys

from pi_mono.ai.types import Model
from pi_mono.coding_agent.core.auth_guidance import format_no_models_available_message
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.tui.fuzzy import fuzzy_filter


def _format_token_count(count: int) -> str:
    if count >= 1_000_000:
        millions = count / 1_000_000
        return f"{int(millions)}M" if millions % 1 == 0 else f"{millions:.1f}M"
    if count >= 1_000:
        thousands = count / 1_000
        return f"{int(thousands)}K" if thousands % 1 == 0 else f"{thousands:.1f}K"
    return str(count)


def list_models(model_registry: ModelRegistry, search_pattern: str | None = None) -> None:
    load_error = model_registry.get_error()
    if load_error:
        print(f"Warning: errors loading models.json:\n{load_error}", file=sys.stderr)

    models = model_registry.get_available()
    if not models:
        print(format_no_models_available_message())
        return

    filtered_models: list[Model] = models
    if search_pattern:
        filtered_models = fuzzy_filter(
            models,
            search_pattern,
            lambda model: f"{model['provider']} {model['id']}",
        )

    if not filtered_models:
        print(f'No models matching "{search_pattern}"')
        return

    filtered_models.sort(key=lambda model: (model["provider"], model["id"]))

    rows = [
        {
            "provider": model["provider"],
            "model": model["id"],
            "context": _format_token_count(model.get("contextWindow", 0)),
            "maxOut": _format_token_count(model.get("maxTokens", 0)),
            "thinking": "yes" if model.get("reasoning") else "no",
            "images": "yes" if "image" in model.get("input", []) else "no",
        }
        for model in filtered_models
    ]

    headers = {
        "provider": "provider",
        "model": "model",
        "context": "context",
        "maxOut": "max-out",
        "thinking": "thinking",
        "images": "images",
    }
    widths = {key: max(len(headers[key]), *(len(row[key]) for row in rows)) for key in headers}

    header_line = "  ".join(headers[key].ljust(widths[key]) for key in headers)
    print(header_line)
    for row in rows:
        print("  ".join(row[key].ljust(widths[key]) for key in headers))
