"""OAuth credential management for AI providers."""

from __future__ import annotations

import asyncio
import time
from typing import Any, List, Optional, Protocol

from pi_mono.ai.types import Model
from pi_mono.ai.utils.oauth import (
    BUILT_IN_OAUTH_PROVIDERS,
    OAuthAuthInfo,
    OAuthCredentials,
    OAuthDeviceCodeInfo,
    OAuthPrompt,
    OAuthSelectPrompt,
    get_oauth_api_key,
    get_oauth_provider,
    get_oauth_providers,
    register_oauth_provider,
    reset_oauth_providers,
    unregister_oauth_provider,
)

__all__ = [
    "OAuthCredentials",
    "OAuthPrompt",
    "OAuthAuthInfo",
    "OAuthDeviceCodeInfo",
    "OAuthSelectPrompt",
    "OAuthLoginCallbacks",
    "OAuthProviderInterface",
    "StubOAuthProvider",
    "BUILT_IN_OAUTH_PROVIDERS",
    "get_oauth_provider",
    "register_oauth_provider",
    "unregister_oauth_provider",
    "reset_oauth_providers",
    "get_oauth_providers",
    "get_oauth_api_key",
]


class OAuthLoginCallbacks:
    def on_auth(self, info: OAuthAuthInfo) -> None:
        pass

    def on_device_code(self, info: OAuthDeviceCodeInfo) -> None:
        pass

    async def on_prompt(self, prompt: OAuthPrompt) -> str:
        return ""

    def on_progress(self, message: str) -> None:
        pass

    async def on_manual_code_input(self) -> str:
        return await self.on_prompt(
            {"message": "Paste the authorization code or full redirect URL:"}
        )

    async def on_select(self, prompt: OAuthSelectPrompt) -> Optional[str]:
        return None

    @property
    def signal(self) -> Any:
        return None


class OAuthProviderInterface(Protocol):
    id: str
    name: str

    async def login(self, callbacks: OAuthLoginCallbacks) -> OAuthCredentials: ...
    def refresh_token(self, credentials: OAuthCredentials) -> OAuthCredentials: ...
    def get_api_key(self, credentials: OAuthCredentials) -> str: ...
    def modify_models(self, models: List[Model], credentials: OAuthCredentials) -> List[Model]: ...


class StubOAuthProvider:
    def __init__(self, provider_id: str, name: str):
        self.id = provider_id
        self.name = name

    async def login(self, callbacks: Any) -> OAuthCredentials:
        raise NotImplementedError(
            f"OAuth login for '{self.name}' is not implemented in Python. "
            f"Please set the appropriate environment variable directly."
        )

    def refresh_token(self, credentials: OAuthCredentials) -> OAuthCredentials:
        return credentials

    def get_api_key(self, credentials: OAuthCredentials) -> str:
        return credentials.get("access", "")

    def modify_models(self, models: List[Model], credentials: OAuthCredentials) -> List[Model]:
        return models


async def _refresh_if_needed(provider: Any, creds: OAuthCredentials) -> OAuthCredentials:
    expires = creds.get("expires")
    if expires is not None and int(time.time() * 1000) >= int(expires):
        result = provider.refresh_token(creds)
        if asyncio.iscoroutine(result):
            return await result
        return result
    return creds
