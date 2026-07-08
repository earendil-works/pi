"""Provider-specific attribution headers for API requests."""

from __future__ import annotations

from urllib.parse import urlparse

from pi_mono.ai.types import Api, Model
from pi_mono.core.settings_manager import SettingsManager

OPENROUTER_HOST = "openrouter.ai"
NVIDIA_NIM_HOST = "integrate.api.nvidia.com"
CLOUDFLARE_API_HOST = "api.cloudflare.com"
CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com"
OPENCODE_HOST = "opencode.ai"


def _matches_host(base_url: str, expected_host: str) -> bool:
    try:
        return urlparse(base_url).hostname == expected_host
    except ValueError:
        return False


def _is_openrouter_model(model: Model[Api]) -> bool:
    return model.get("provider") == "openrouter" or OPENROUTER_HOST in model.get("baseUrl", "")


def _is_nvidia_nim_model(model: Model[Api]) -> bool:
    return model.get("provider") == "nvidia" or _matches_host(
        model.get("baseUrl", ""), NVIDIA_NIM_HOST
    )


def _is_cloudflare_model(model: Model[Api]) -> bool:
    provider = model.get("provider", "")
    base_url = model.get("baseUrl", "")
    return (
        provider in ("cloudflare-workers-ai", "cloudflare-ai-gateway")
        or _matches_host(base_url, CLOUDFLARE_API_HOST)
        or _matches_host(base_url, CLOUDFLARE_AI_GATEWAY_HOST)
    )


def _get_default_attribution_headers(
    model: Model[Api],
    settings_manager: SettingsManager,
) -> dict[str, str] | None:
    if not settings_manager.get_enable_install_telemetry():
        return None

    if _is_openrouter_model(model):
        return {
            "HTTP-Referer": "https://pi.dev",
            "X-OpenRouter-Title": "pi",
            "X-OpenRouter-Categories": "cli-agent",
        }

    if _is_nvidia_nim_model(model):
        return {"X-BILLING-INVOKE-ORIGIN": "Pi"}

    if _is_cloudflare_model(model):
        return {"User-Agent": "pi-coding-agent"}

    return None


def _get_session_headers(model: Model[Api], session_id: str | None) -> dict[str, str] | None:
    if not session_id:
        return None
    provider = model.get("provider", "")
    if provider not in ("opencode", "opencode-go") and not _matches_host(
        model.get("baseUrl", ""), OPENCODE_HOST
    ):
        return None
    return {"x-opencode-session": session_id, "x-opencode-client": "pi"}


def merge_provider_attribution_headers(
    model: Model[Api],
    settings_manager: SettingsManager,
    session_id: str | None,
    *header_sources: dict[str, str] | None,
) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    session_headers = _get_session_headers(model, session_id)
    if session_headers:
        merged.update(session_headers)
    default_headers = _get_default_attribution_headers(model, settings_manager)
    if default_headers:
        merged.update(default_headers)
    for headers in header_sources:
        if headers:
            merged.update(headers)
    return merged or None
