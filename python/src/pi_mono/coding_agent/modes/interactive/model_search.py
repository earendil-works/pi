"""Model selector search text helpers."""

from __future__ import annotations

from typing import Protocol


class ModelSearchItem(Protocol):
    id: str
    provider: str
    name: str | None


def get_model_search_text(item: ModelSearchItem) -> str:
    model_id = item.id
    provider = item.provider
    name = f" {item.name}" if item.name else ""
    return f"{model_id} {provider} {provider}/{model_id} {provider} {model_id}{name}"


def get_model_selector_search_text(item: ModelSearchItem) -> str:
    """Rank exact provider-prefixed queries before proxy-provider IDs."""
    model_id = item.id
    provider = item.provider
    name = f" {item.name}" if item.name else ""
    return f"{provider} {provider}/{model_id} {provider} {model_id}{name}"
