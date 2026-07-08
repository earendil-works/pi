"""OAuth utilities package."""

from typing import Any

from pi_mono.ai.utils.oauth.anthropic import (
    AnthropicOAuthProvider,
    anthropic_oauth_provider,
    login_anthropic,
    refresh_anthropic_token,
)
from pi_mono.ai.utils.oauth.device_code import (
    OAuthDeviceCodeIncompletePollResult,
    OAuthDeviceCodePollOptions,
    OAuthDeviceCodePollResult,
    poll_oauth_device_code_flow,
)
from pi_mono.ai.utils.oauth.github_copilot import (
    GitHubCopilotOAuthProvider,
    get_github_copilot_base_url,
    github_copilot_oauth_provider,
    login_github_copilot,
    normalize_domain,
    refresh_github_copilot_token,
)
from pi_mono.ai.utils.oauth.oauth_page import oauth_error_html, oauth_success_html
from pi_mono.ai.utils.oauth.openai_codex import (
    OPENAI_CODEX_BROWSER_LOGIN_METHOD,
    OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
    OpenAICodexOAuthProvider,
    login_openai_codex,
    login_openai_codex_device_code,
    openai_codex_oauth_provider,
    refresh_openai_codex_token,
)
from pi_mono.ai.utils.oauth.cursor import (
    CursorOAuthProvider,
    cursor_oauth_provider,
)
from pi_mono.ai.utils.oauth.pkce import generate_pkce
from pi_mono.ai.utils.oauth.types import (
    OAuthAuthInfo,
    OAuthCredentials,
    OAuthDeviceCodeInfo,
    OAuthLoginCallbacks,
    OAuthPrompt,
    OAuthProvider,
    OAuthProviderId,
    OAuthProviderInfo,
    OAuthProviderInterface,
    OAuthSelectOption,
    OAuthSelectPrompt,
)

BUILT_IN_OAUTH_PROVIDERS: list[Any] = [
    anthropic_oauth_provider,
    github_copilot_oauth_provider,
    openai_codex_oauth_provider,
    cursor_oauth_provider,
]

_oauth_provider_registry: dict[str, Any] = {p.id: p for p in BUILT_IN_OAUTH_PROVIDERS}


def get_oauth_provider(provider_id: str) -> Any | None:
    return _oauth_provider_registry.get(provider_id)


def register_oauth_provider(provider: Any) -> None:
    _oauth_provider_registry[provider.id] = provider


def unregister_oauth_provider(provider_id: str) -> None:
    built_in = next((p for p in BUILT_IN_OAUTH_PROVIDERS if p.id == provider_id), None)
    if built_in:
        _oauth_provider_registry[provider_id] = built_in
    else:
        _oauth_provider_registry.pop(provider_id, None)


def reset_oauth_providers() -> None:
    _oauth_provider_registry.clear()
    for provider in BUILT_IN_OAUTH_PROVIDERS:
        _oauth_provider_registry[provider.id] = provider


def get_oauth_providers() -> list[Any]:
    return list(_oauth_provider_registry.values())


def get_oauth_provider_info_list() -> list[OAuthProviderInfo]:
    return [{"id": p.id, "name": p.name, "available": True} for p in get_oauth_providers()]


async def refresh_oauth_token(provider_id: str, credentials: OAuthCredentials) -> OAuthCredentials:
    provider = get_oauth_provider(provider_id)
    if not provider:
        raise ValueError(f"Unknown OAuth provider: {provider_id}")
    result = provider.refresh_token(credentials)
    import asyncio

    if asyncio.iscoroutine(result):
        return await result
    return result


async def get_oauth_api_key(
    provider_id: str,
    credentials: dict[str, OAuthCredentials],
) -> dict[str, Any] | None:
    provider = get_oauth_provider(provider_id)
    if not provider:
        raise ValueError(f"Unknown OAuth provider: {provider_id}")

    creds = credentials.get(provider_id)
    if not creds:
        return None

    import time

    expires = creds.get("expires")
    if expires is not None and int(time.time() * 1000) >= int(expires):
        try:
            result = provider.refresh_token(creds)
            import asyncio

            creds = await result if asyncio.iscoroutine(result) else result
        except Exception as error:
            raise RuntimeError(f"Failed to refresh OAuth token for {provider_id}") from error

    return {"newCredentials": creds, "apiKey": provider.get_api_key(creds)}


__all__ = [
    "AnthropicOAuthProvider",
    "GitHubCopilotOAuthProvider",
    "OpenAICodexOAuthProvider",
    "CursorOAuthProvider",
    "OAuthCredentials",
    "OAuthProviderId",
    "OAuthProvider",
    "OAuthPrompt",
    "OAuthAuthInfo",
    "OAuthDeviceCodeInfo",
    "OAuthSelectOption",
    "OAuthSelectPrompt",
    "OAuthLoginCallbacks",
    "OAuthProviderInterface",
    "OAuthProviderInfo",
    "OAuthDeviceCodeIncompletePollResult",
    "OAuthDeviceCodePollOptions",
    "OAuthDeviceCodePollResult",
    "OPENAI_CODEX_BROWSER_LOGIN_METHOD",
    "OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD",
    "BUILT_IN_OAUTH_PROVIDERS",
    "anthropic_oauth_provider",
    "github_copilot_oauth_provider",
    "openai_codex_oauth_provider",
    "cursor_oauth_provider",
    "generate_pkce",
    "get_github_copilot_base_url",
    "get_oauth_api_key",
    "get_oauth_provider",
    "get_oauth_provider_info_list",
    "get_oauth_providers",
    "login_anthropic",
    "login_github_copilot",
    "login_openai_codex",
    "login_openai_codex_device_code",
    "normalize_domain",
    "oauth_error_html",
    "oauth_success_html",
    "poll_oauth_device_code_flow",
    "refresh_anthropic_token",
    "refresh_github_copilot_token",
    "refresh_oauth_token",
    "refresh_openai_codex_token",
    "register_oauth_provider",
    "reset_oauth_providers",
    "unregister_oauth_provider",
]
