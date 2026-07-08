"""GitHub Copilot OAuth flow."""

from __future__ import annotations

import base64
from typing import Any, Callable
from urllib.parse import urlencode, urlparse

import httpx

from pi_mono.ai.models import get_models
from pi_mono.ai.types import Model
from pi_mono.ai.utils.oauth.device_code import poll_oauth_device_code_flow
from pi_mono.ai.utils.oauth.types import OAuthCredentials, OAuthDeviceCodeInfo, OAuthPrompt

CLIENT_ID = base64.b64decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=").decode("ascii")

COPILOT_HEADERS = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
}
COPILOT_API_VERSION = "2026-06-01"


def _as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def is_selectable_copilot_model(item: dict[str, Any]) -> bool:
    policy = _as_record(item.get("policy"))
    capabilities = _as_record(item.get("capabilities"))
    supports = _as_record(capabilities.get("supports")) if capabilities else None
    return (
        item.get("model_picker_enabled") is True
        and (policy or {}).get("state") != "disabled"
        and (supports or {}).get("tool_calls") is not False
    )


def parse_available_copilot_model_ids(raw: Any) -> list[str]:
    data = _as_record(raw)
    if data is None or not isinstance(data.get("data"), list):
        raise RuntimeError("Invalid Copilot models response")
    ids: list[str] = []
    for raw_item in data["data"]:
        item = _as_record(raw_item)
        model_id = item.get("id") if item else None
        if isinstance(model_id, str) and item and is_selectable_copilot_model(item):
            ids.append(model_id)
    return ids


async def fetch_available_github_copilot_model_ids(
    copilot_token: str,
    enterprise_domain: str | None = None,
) -> list[str]:
    base_url = get_github_copilot_base_url(copilot_token, enterprise_domain)
    raw = await _fetch_json(
        f"{base_url}/models",
        {
            "method": "GET",
            "headers": {
                "Accept": "application/json",
                "Authorization": f"Bearer {copilot_token}",
                **COPILOT_HEADERS,
                "X-GitHub-Api-Version": COPILOT_API_VERSION,
            },
            "timeout": 5.0,
        },
    )
    return parse_available_copilot_model_ids(raw)


def normalize_domain(input_value: str) -> str | None:
    trimmed = input_value.strip()
    if not trimmed:
        return None
    host_part = trimmed.split("://", 1)[-1].split("/", 1)[0]
    if " " in host_part or "%" in host_part:
        return None
    candidate = trimmed if "://" in trimmed else f"https://{trimmed}"
    try:
        hostname = httpx.URL(candidate).host
        return hostname if hostname else None
    except Exception:
        return None


def _get_urls(domain: str) -> dict[str, str]:
    return {
        "deviceCodeUrl": f"https://{domain}/login/device/code",
        "accessTokenUrl": f"https://{domain}/login/oauth/access_token",
        "copilotTokenUrl": f"https://api.{domain}/copilot_internal/v2/token",
    }


def _get_base_url_from_token(token: str) -> str | None:
    import re

    match = re.search(r"proxy-ep=([^;]+)", token)
    if not match:
        return None
    proxy_host = match.group(1)
    api_host = proxy_host.removeprefix("proxy.")
    return f"https://api.{api_host}"


def get_github_copilot_base_url(
    token: str | None = None, enterprise_domain: str | None = None
) -> str:
    if token:
        url_from_token = _get_base_url_from_token(token)
        if url_from_token:
            return url_from_token
    if enterprise_domain:
        return f"https://copilot-api.{enterprise_domain}"
    return "https://api.individual.githubcopilot.com"


async def _fetch_json(url: str, init: dict[str, Any]) -> Any:
    timeout = init.pop("timeout", 30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(url=url, **init)
        if not response.is_success:
            raise RuntimeError(f"{response.status_code} {response.reason_phrase}: {response.text}")
        return response.json()


class _DeviceCodeResponse:
    def __init__(
        self,
        device_code: str,
        user_code: str,
        verification_uri: str,
        expires_in: int,
        interval: int | None = None,
    ) -> None:
        self.device_code = device_code
        self.user_code = user_code
        self.verification_uri = verification_uri
        self.expires_in = expires_in
        self.interval = interval


async def _start_device_flow(domain: str) -> _DeviceCodeResponse:
    urls = _get_urls(domain)
    data = await _fetch_json(
        urls["deviceCodeUrl"],
        {
            "method": "POST",
            "headers": {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "GitHubCopilotChat/0.35.0",
            },
            "content": urlencode({"client_id": CLIENT_ID, "scope": "read:user"}),
        },
    )

    if not isinstance(data, dict):
        raise RuntimeError("Invalid device code response")

    device_code = data.get("device_code")
    user_code = data.get("user_code")
    verification_uri = data.get("verification_uri")
    interval = data.get("interval")
    expires_in = data.get("expires_in")

    if (
        not isinstance(device_code, str)
        or not isinstance(user_code, str)
        or not isinstance(verification_uri, str)
        or (interval is not None and not isinstance(interval, int))
        or not isinstance(expires_in, int)
    ):
        raise RuntimeError("Invalid device code response fields")

    try:
        parsed_uri = urlparse(verification_uri)
    except ValueError as error:
        raise RuntimeError("Untrusted verification_uri in device code response") from error
    if parsed_uri.scheme not in ("https", "http"):
        raise RuntimeError("Untrusted verification_uri in device code response")

    return _DeviceCodeResponse(
        device_code=device_code,
        user_code=user_code,
        verification_uri=parsed_uri.geturl(),
        interval=interval,
        expires_in=expires_in,
    )


class _PollOptions:
    def __init__(
        self,
        interval_seconds: int | None,
        expires_in_seconds: int,
        poll: Callable[[], Any],
        signal: Any | None = None,
    ) -> None:
        self.intervalSeconds = interval_seconds
        self.expiresInSeconds = expires_in_seconds
        self.poll = poll
        self.signal = signal


async def _poll_for_github_access_token(
    domain: str,
    device: _DeviceCodeResponse,
    signal: Any | None = None,
) -> str:
    urls = _get_urls(domain)

    async def poll() -> dict[str, Any]:
        raw = await _fetch_json(
            urls["accessTokenUrl"],
            {
                "method": "POST",
                "headers": {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "GitHubCopilotChat/0.35.0",
                },
                "content": urlencode(
                    {
                        "client_id": CLIENT_ID,
                        "device_code": device.device_code,
                        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    }
                ),
            },
        )

        if isinstance(raw, dict) and isinstance(raw.get("access_token"), str):
            return {"status": "complete", "value": raw["access_token"]}

        if isinstance(raw, dict) and isinstance(raw.get("error"), str):
            error = raw["error"]
            description = raw.get("error_description")
            if error == "authorization_pending":
                return {"status": "pending"}
            if error == "slow_down":
                return {"status": "slow_down"}
            suffix = f": {description}" if description else ""
            return {"status": "failed", "message": f"Device flow failed: {error}{suffix}"}

        return {"status": "failed", "message": "Invalid device token response"}

    return await poll_oauth_device_code_flow(
        _PollOptions(device.interval, device.expires_in, poll, signal)
    )


async def refresh_github_copilot_token(
    refresh_token: str,
    enterprise_domain: str | None = None,
) -> OAuthCredentials:
    """Refresh GitHub Copilot token."""
    domain = enterprise_domain or "github.com"
    urls = _get_urls(domain)

    raw = await _fetch_json(
        urls["copilotTokenUrl"],
        {
            "method": "GET",
            "headers": {
                "Accept": "application/json",
                "Authorization": f"Bearer {refresh_token}",
                **COPILOT_HEADERS,
            },
        },
    )

    if not isinstance(raw, dict):
        raise RuntimeError("Invalid Copilot token response")

    token = raw.get("token")
    expires_at = raw.get("expires_at")
    if not isinstance(token, str) or not isinstance(expires_at, int):
        raise RuntimeError("Invalid Copilot token response fields")

    creds: OAuthCredentials = {
        "refresh": refresh_token,
        "access": token,
        "expires": expires_at * 1000 - 5 * 60 * 1000,
    }
    if enterprise_domain:
        creds["enterpriseUrl"] = enterprise_domain
    return creds


async def _enable_github_copilot_model(
    token: str,
    model_id: str,
    enterprise_domain: str | None = None,
) -> bool:
    base_url = get_github_copilot_base_url(token, enterprise_domain)
    url = f"{base_url}/models/{model_id}/policy"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}",
                    **COPILOT_HEADERS,
                    "openai-intent": "chat-policy",
                    "x-interaction-type": "chat-policy",
                },
                json={"state": "enabled"},
            )
            return response.is_success
    except Exception:
        return False


async def _enable_all_github_copilot_models(
    token: str,
    enterprise_domain: str | None = None,
    on_progress: Callable[[str, bool], None] | None = None,
) -> None:
    models = get_models("github-copilot")
    import asyncio

    async def enable_one(model: Model) -> None:
        success = await _enable_github_copilot_model(token, model["id"], enterprise_domain)
        if on_progress:
            on_progress(model["id"], success)

    await asyncio.gather(*(enable_one(model) for model in models))


async def login_github_copilot(
    *,
    on_device_code: Callable[[OAuthDeviceCodeInfo], None],
    on_prompt: Callable[[OAuthPrompt], Any],
    on_progress: Callable[[str], None] | None = None,
    signal: Any | None = None,
) -> OAuthCredentials:
    """Login with GitHub Copilot OAuth (device code flow)."""
    if signal and signal.get("aborted"):
        raise RuntimeError("Login cancelled")

    input_value = await on_prompt(
        {
            "message": "GitHub Enterprise URL/domain (blank for github.com)",
            "placeholder": "company.ghe.com",
            "allowEmpty": True,
        }
    )

    if signal and signal.get("aborted"):
        raise RuntimeError("Login cancelled")

    trimmed = input_value.strip()
    enterprise_domain = normalize_domain(input_value)
    if trimmed and not enterprise_domain:
        raise RuntimeError("Invalid GitHub Enterprise URL/domain")
    domain = enterprise_domain or "github.com"

    device = await _start_device_flow(domain)
    on_device_code(
        {
            "userCode": device.user_code,
            "verificationUri": device.verification_uri,
            "intervalSeconds": device.interval,
            "expiresInSeconds": device.expires_in,
        }
    )

    github_access_token = await _poll_for_github_access_token(domain, device, signal)
    credentials = await refresh_github_copilot_token(github_access_token, enterprise_domain)

    if on_progress:
        on_progress("Enabling models...")
    await _enable_all_github_copilot_models(credentials["access"], enterprise_domain)
    credentials["availableModelIds"] = await fetch_available_github_copilot_model_ids(
        credentials["access"], enterprise_domain
    )
    return credentials


class GitHubCopilotOAuthProvider:
    id = "github-copilot"
    name = "GitHub Copilot"

    async def login(self, callbacks: Any) -> OAuthCredentials:
        on_device_code = (
            callbacks.on_device_code
            if hasattr(callbacks, "on_device_code")
            else callbacks["onDeviceCode"]
        )
        on_prompt = (
            callbacks.on_prompt if hasattr(callbacks, "on_prompt") else callbacks["onPrompt"]
        )
        on_progress = (
            callbacks.on_progress
            if hasattr(callbacks, "on_progress")
            else callbacks.get("onProgress")
        )
        signal = callbacks.signal if hasattr(callbacks, "signal") else callbacks.get("signal")
        return await login_github_copilot(
            on_device_code=on_device_code,
            on_prompt=on_prompt,
            on_progress=on_progress,
            signal=signal,
        )

    async def refresh_token(self, credentials: OAuthCredentials) -> OAuthCredentials:
        enterprise_url = credentials.get("enterpriseUrl")
        return await refresh_github_copilot_token(credentials["refresh"], enterprise_url)

    def get_api_key(self, credentials: OAuthCredentials) -> str:
        return credentials["access"]

    def modify_models(self, models: list[Model], credentials: OAuthCredentials) -> list[Model]:
        enterprise_url = credentials.get("enterpriseUrl")
        domain = normalize_domain(enterprise_url) if enterprise_url else None
        base_url = get_github_copilot_base_url(credentials["access"], domain)
        available_model_ids = credentials.get("availableModelIds")
        available_set = set(available_model_ids) if isinstance(available_model_ids, list) else None
        result: list[Model] = []
        for model in models:
            if model.get("provider") != "github-copilot":
                result.append(model)
                continue
            if available_set is not None and model.get("id") not in available_set:
                continue
            result.append({**model, "baseUrl": base_url})
        return result


github_copilot_oauth_provider = GitHubCopilotOAuthProvider()
