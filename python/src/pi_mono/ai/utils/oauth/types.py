"""OAuth types for Python."""

from typing import Any, NotRequired, TypedDict


class OAuthCredentials(TypedDict, total=False):
    refresh: str
    access: str
    expires: int
    enterpriseUrl: str
    availableModelIds: list[str]


OAuthProviderId = str
OAuthProvider = OAuthProviderId  # deprecated alias


class OAuthPrompt(TypedDict, total=False):
    message: str
    placeholder: str
    allowEmpty: bool


class OAuthAuthInfo(TypedDict, total=False):
    url: str
    instructions: str


class OAuthDeviceCodeInfo(TypedDict):
    userCode: str
    verificationUri: str
    intervalSeconds: NotRequired[int | None]
    expiresInSeconds: NotRequired[int | None]


class OAuthSelectOption(TypedDict):
    id: str
    label: str


class OAuthSelectPrompt(TypedDict):
    message: str
    options: list[OAuthSelectOption]


class OAuthLoginCallbacks(TypedDict, total=False):
    onAuth: Any  # (info: OAuthAuthInfo) -> None
    onDeviceCode: Any  # (info: OAuthDeviceCodeInfo) -> None
    onPrompt: Any  # (prompt: OAuthPrompt) -> Awaitable[str]
    onProgress: Any  # (message: str) -> None
    onManualCodeInput: Any  # () -> Awaitable[str]
    onSelect: Any  # (prompt: OAuthSelectPrompt) -> Awaitable[str | None]
    signal: Any  # AbortSignal


class OAuthProviderInterface(TypedDict, total=False):
    id: OAuthProviderId
    name: str
    login: Any  # (callbacks: OAuthLoginCallbacks) -> Awaitable[OAuthCredentials]
    usesCallbackServer: bool
    refreshToken: Any  # (credentials: OAuthCredentials) -> Awaitable[OAuthCredentials]
    getApiKey: Any  # (credentials: OAuthCredentials) -> str
    modifyModels: Any  # (models: list, credentials: OAuthCredentials) -> list


class OAuthProviderInfo(TypedDict):
    id: OAuthProviderId
    name: str
    available: bool
