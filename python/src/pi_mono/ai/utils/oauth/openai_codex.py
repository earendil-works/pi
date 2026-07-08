"""OpenAI Codex (ChatGPT OAuth) flow."""

from __future__ import annotations

import base64
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from pi_mono.ai.utils.oauth.device_code import poll_oauth_device_code_flow
from pi_mono.ai.utils.oauth.oauth_page import oauth_error_html, oauth_success_html
from pi_mono.ai.utils.oauth.pkce import generate_pkce
from pi_mono.ai.utils.oauth.types import OAuthCredentials, OAuthDeviceCodeInfo, OAuthPrompt

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
AUTH_BASE_URL = "https://auth.openai.com"
AUTHORIZE_URL = f"{AUTH_BASE_URL}/oauth/authorize"
TOKEN_URL = f"{AUTH_BASE_URL}/oauth/token"
REDIRECT_URI = "http://localhost:1455/auth/callback"
DEVICE_USER_CODE_URL = f"{AUTH_BASE_URL}/api/accounts/deviceauth/usercode"
DEVICE_TOKEN_URL = f"{AUTH_BASE_URL}/api/accounts/deviceauth/token"
DEVICE_VERIFICATION_URI = f"{AUTH_BASE_URL}/codex/device"
DEVICE_REDIRECT_URI = f"{AUTH_BASE_URL}/deviceauth/callback"
DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
OPENAI_CODEX_BROWSER_LOGIN_METHOD = "browser"
OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code"
SCOPE = "openid profile email offline_access"
JWT_CLAIM_PATH = "https://api.openai.com/auth"


def _get_callback_host() -> str:
    return os.environ.get("PI_OAUTH_CALLBACK_HOST", "127.0.0.1")


def _parse_authorization_input(input_value: str) -> dict[str, str | None]:
    value = input_value.strip()
    if not value:
        return {}

    try:
        url = urlparse(value)
        if url.scheme and url.netloc:
            params = parse_qs(url.query)
            return {
                "code": params.get("code", [None])[0],
                "state": params.get("state", [None])[0],
            }
    except ValueError:
        pass

    if "#" in value:
        code, state = value.split("#", 1)
        return {"code": code, "state": state}

    if "code=" in value:
        params = parse_qs(value)
        return {
            "code": params.get("code", [None])[0],
            "state": params.get("state", [None])[0],
        }

    return {"code": value}


def _decode_jwt(token: str) -> dict[str, Any] | None:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload = parts[1]
        padding = "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload + padding)
        return json.loads(decoded)
    except Exception:
        return None


def _is_aborted(signal: Any | None) -> bool:
    return bool(signal and signal.get("aborted"))


async def _fetch_with_login_cancellation(
    url: str,
    init: dict[str, Any],
    signal: Any | None = None,
) -> httpx.Response:
    if _is_aborted(signal):
        raise RuntimeError("Login cancelled")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            return await client.request(url=url, **init)
    except Exception as error:
        if _is_aborted(signal):
            raise RuntimeError("Login cancelled") from error
        raise


async def _read_token_response(response: httpx.Response, operation: str) -> dict[str, Any]:
    if not response.is_success:
        text = response.text
        raise RuntimeError(
            f"OpenAI Codex token {operation} failed ({response.status_code}): "
            f"{text or response.reason_phrase}"
        )

    raw_json = response.json()
    if (
        not isinstance(raw_json, dict)
        or not isinstance(raw_json.get("access_token"), str)
        or not isinstance(raw_json.get("refresh_token"), str)
        or not isinstance(raw_json.get("expires_in"), (int, float))
    ):
        raise RuntimeError(
            f"OpenAI Codex token {operation} response missing fields: {json.dumps(raw_json)}"
        )

    expires_in = int(raw_json["expires_in"])
    return {
        "access": raw_json["access_token"],
        "refresh": raw_json["refresh_token"],
        "expires": int(time.time() * 1000) + expires_in * 1000,
    }


async def _exchange_authorization_code(
    code: str,
    verifier: str,
    redirect_uri: str = REDIRECT_URI,
    signal: Any | None = None,
) -> dict[str, Any]:
    response = await _fetch_with_login_cancellation(
        TOKEN_URL,
        {
            "method": "POST",
            "headers": {"Content-Type": "application/x-www-form-urlencoded"},
            "content": urlencode(
                {
                    "grant_type": "authorization_code",
                    "client_id": CLIENT_ID,
                    "code": code,
                    "code_verifier": verifier,
                    "redirect_uri": redirect_uri,
                }
            ),
        },
        signal,
    )
    return await _read_token_response(response, "exchange")


async def _refresh_access_token(refresh_token: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                TOKEN_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                content=urlencode(
                    {
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                        "client_id": CLIENT_ID,
                    }
                ),
            )
    except Exception as error:
        raise RuntimeError(
            f"OpenAI Codex token refresh error: {error if isinstance(error, BaseException) else str(error)}"
        ) from error
    return await _read_token_response(response, "refresh")


class _DeviceAuthInfo:
    def __init__(self, device_auth_id: str, user_code: str, interval_seconds: int) -> None:
        self.device_auth_id = device_auth_id
        self.user_code = user_code
        self.interval_seconds = interval_seconds


async def _start_openai_codex_device_auth(signal: Any | None = None) -> _DeviceAuthInfo:
    response = await _fetch_with_login_cancellation(
        DEVICE_USER_CODE_URL,
        {
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "content": json.dumps({"client_id": CLIENT_ID}),
        },
        signal,
    )

    if not response.is_success:
        if response.status_code == 404:
            raise RuntimeError(
                "OpenAI Codex device code login is not enabled for this server. "
                "Use browser login or verify the server URL."
            )
        body = response.text
        raise RuntimeError(
            f"OpenAI Codex device code request failed with status {response.status_code}"
            + (f": {body}" if body else "")
        )

    raw_json = response.json()
    interval = raw_json.get("interval") if isinstance(raw_json, dict) else None
    interval_seconds = int(str(interval).strip()) if isinstance(interval, str) else interval
    if (
        not isinstance(raw_json, dict)
        or not isinstance(raw_json.get("device_auth_id"), str)
        or not isinstance(raw_json.get("user_code"), str)
        or not isinstance(interval_seconds, (int, float))
        or interval_seconds < 0
    ):
        raise RuntimeError(f"Invalid OpenAI Codex device code response: {json.dumps(raw_json)}")

    return _DeviceAuthInfo(raw_json["device_auth_id"], raw_json["user_code"], int(interval_seconds))


class _PollOptions:
    def __init__(
        self,
        interval_seconds: int,
        expires_in_seconds: int,
        poll: Callable[[], Any],
        signal: Any | None = None,
    ) -> None:
        self.intervalSeconds = interval_seconds
        self.expiresInSeconds = expires_in_seconds
        self.poll = poll
        self.signal = signal


async def _poll_openai_codex_device_auth(
    device: _DeviceAuthInfo,
    signal: Any | None = None,
) -> dict[str, str]:
    async def poll() -> dict[str, Any]:
        response = await _fetch_with_login_cancellation(
            DEVICE_TOKEN_URL,
            {
                "method": "POST",
                "headers": {"Content-Type": "application/json"},
                "content": json.dumps(
                    {
                        "device_auth_id": device.device_auth_id,
                        "user_code": device.user_code,
                    }
                ),
            },
            signal,
        )

        if response.is_success:
            raw_json = response.json()
            if (
                not isinstance(raw_json, dict)
                or not isinstance(raw_json.get("authorization_code"), str)
                or not isinstance(raw_json.get("code_verifier"), str)
            ):
                return {
                    "status": "failed",
                    "message": f"Invalid OpenAI Codex device auth token response: {json.dumps(raw_json)}",
                }
            return {
                "status": "complete",
                "value": {
                    "authorizationCode": raw_json["authorization_code"],
                    "codeVerifier": raw_json["code_verifier"],
                },
            }

        if response.status_code in (403, 404):
            return {"status": "pending"}

        response_body = response.text
        error_code: Any = None
        try:
            parsed = json.loads(response_body)
            if isinstance(parsed, dict):
                error = parsed.get("error")
                error_code = error.get("code") if isinstance(error, dict) else error
        except json.JSONDecodeError:
            pass

        if error_code == "deviceauth_authorization_pending":
            return {"status": "pending"}
        if error_code == "slow_down":
            return {"status": "slow_down"}

        return {
            "status": "failed",
            "message": (
                f"OpenAI Codex device auth failed with status {response.status_code}"
                + (f": {response_body}" if response_body else "")
            ),
        }

    return await poll_oauth_device_code_flow(
        _PollOptions(device.interval_seconds, DEVICE_CODE_TIMEOUT_SECONDS, poll, signal)
    )


async def _create_authorization_flow(originator: str = "pi") -> dict[str, str]:
    pkce = await generate_pkce()
    verifier = pkce["verifier"]
    challenge = pkce["challenge"]
    state = secrets.token_hex(16)

    params = urlencode(
        {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "originator": originator,
        }
    )
    return {"verifier": verifier, "state": state, "url": f"{AUTHORIZE_URL}?{params}"}


class _ReuseHTTPServer(HTTPServer):
    allow_reuse_address = True


class _OAuthServerInfo:
    def __init__(
        self,
        server: HTTPServer | None,
        cancel_wait: Callable[[], None],
        wait_for_code: Callable[[], Any],
    ) -> None:
        self.server = server
        self.cancel_wait = cancel_wait
        self.wait_for_code = wait_for_code

    def close(self) -> None:
        if self.server is not None:
            self.server.shutdown()


async def _start_local_oauth_server(state: str) -> _OAuthServerInfo:
    import asyncio

    loop = asyncio.get_running_loop()
    result_future: asyncio.Future[dict[str, str] | None] = loop.create_future()

    def settle_wait(value: dict[str, str] | None) -> None:
        if not result_future.done():
            result_future.set_result(value)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            try:
                parsed = urlparse(self.path)
                if parsed.path != "/auth/callback":
                    self._send_html(404, oauth_error_html("Callback route not found."))
                    return
                params = parse_qs(parsed.query)
                if params.get("state", [None])[0] != state:
                    self._send_html(400, oauth_error_html("State mismatch."))
                    return
                code = params.get("code", [None])[0]
                if not code:
                    self._send_html(400, oauth_error_html("Missing authorization code."))
                    return
                self._send_html(
                    200,
                    oauth_success_html(
                        "OpenAI authentication completed. You can close this window."
                    ),
                )
                settle_wait({"code": code})
            except Exception:
                self._send_html(
                    500,
                    oauth_error_html("Internal error while processing OAuth callback."),
                )

        def _send_html(self, status: int, body: str) -> None:
            encoded = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:
            return

    try:
        server = _ReuseHTTPServer((_get_callback_host(), 1455), Handler)
    except OSError:
        settle_wait(None)
        return _OAuthServerInfo(
            server=None,
            cancel_wait=lambda: None,
            wait_for_code=lambda: result_future,
        )

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    return _OAuthServerInfo(
        server=server,
        cancel_wait=lambda: settle_wait(None),
        wait_for_code=lambda: result_future,
    )


def _get_account_id(access_token: str) -> str | None:
    payload = _decode_jwt(access_token)
    if not payload:
        return None
    auth = payload.get(JWT_CLAIM_PATH)
    if not isinstance(auth, dict):
        return None
    account_id = auth.get("chatgpt_account_id")
    return account_id if isinstance(account_id, str) and account_id else None


def _credentials_from_token(token: dict[str, Any]) -> OAuthCredentials:
    account_id = _get_account_id(token["access"])
    if not account_id:
        raise RuntimeError("Failed to extract accountId from token")
    return {
        "access": token["access"],
        "refresh": token["refresh"],
        "expires": token["expires"],
        "accountId": account_id,
    }


async def _exchange_authorization_code_for_credentials(
    code: str,
    verifier: str,
    redirect_uri: str,
    signal: Any | None = None,
) -> OAuthCredentials:
    return _credentials_from_token(
        await _exchange_authorization_code(code, verifier, redirect_uri, signal)
    )


async def login_openai_codex_device_code(
    *,
    on_device_code: Callable[[OAuthDeviceCodeInfo], None],
    signal: Any | None = None,
) -> OAuthCredentials:
    """Login with OpenAI Codex OAuth using the Codex device-code flow."""
    device = await _start_openai_codex_device_auth(signal)
    on_device_code(
        {
            "userCode": device.user_code,
            "verificationUri": DEVICE_VERIFICATION_URI,
            "intervalSeconds": device.interval_seconds,
            "expiresInSeconds": DEVICE_CODE_TIMEOUT_SECONDS,
        }
    )
    code = await _poll_openai_codex_device_auth(device, signal)
    return await _exchange_authorization_code_for_credentials(
        code["authorizationCode"],
        code["codeVerifier"],
        DEVICE_REDIRECT_URI,
        signal,
    )


def _is_retryable_login_error(error: BaseException) -> bool:
    message = str(error).lower()
    return any(
        token in message
        for token in (
            "token exchange",
            "authorization code",
            "invalid",
            "expired",
            "missing authorization code",
            "state mismatch",
        )
    )


async def _cancel_login_task(task: Any | None) -> None:
    if task is None or task.done():
        return
    import asyncio

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def login_openai_codex(
    *,
    on_auth: Callable[[dict[str, str]], None],
    on_prompt: Callable[[OAuthPrompt], Any],
    on_progress: Callable[[str], None] | None = None,
    on_manual_code_input: Callable[[], Any] | None = None,
    originator: str = "pi",
) -> OAuthCredentials:
    """Login with OpenAI Codex OAuth."""
    flow = await _create_authorization_flow(originator)
    verifier = flow["verifier"]
    state = flow["state"]
    url = flow["url"]
    server = await _start_local_oauth_server(state)

    on_auth({"url": url, "instructions": "A browser window should open. Complete login to finish."})

    code: str | None = None
    manual_task: Any | None = None
    try:
        if on_manual_code_input is not None:
            import asyncio

            manual_code: str | None = None
            manual_error: BaseException | None = None

            async def _run_manual() -> None:
                nonlocal manual_code, manual_error
                try:
                    manual_code = await on_manual_code_input()
                except BaseException as err:
                    manual_error = err
                finally:
                    server.cancel_wait()

            manual_task = asyncio.create_task(_run_manual())
            result = await server.wait_for_code()

            if manual_error is not None:
                raise manual_error

            if result and result.get("code"):
                code = result["code"]
            elif manual_code:
                parsed = _parse_authorization_input(manual_code)
                if parsed.get("state") and parsed["state"] != state:
                    raise RuntimeError("State mismatch")
                code = parsed.get("code")

            if not code:
                if manual_task and not manual_task.done():
                    await manual_task
                if manual_error is not None:
                    raise manual_error
                if manual_code:
                    parsed = _parse_authorization_input(manual_code)
                    if parsed.get("state") and parsed["state"] != state:
                        raise RuntimeError("State mismatch")
                    code = parsed.get("code")
        else:
            result = await server.wait_for_code()
            if result and result.get("code"):
                code = result["code"]

        while True:
            if not code:
                prompt_input = await on_prompt(
                    {"message": "Paste the authorization code (or full redirect URL):"}
                )
                if not str(prompt_input).strip():
                    raise RuntimeError("Login cancelled")
                parsed = _parse_authorization_input(prompt_input)
                if parsed.get("state") and parsed["state"] != state:
                    raise RuntimeError("State mismatch")
                code = parsed.get("code")
                if not code:
                    message = "No authorization code found in input. Try again."
                    if on_progress:
                        on_progress(message)
                    else:
                        print(message, file=sys.stderr)
                    continue

            try:
                return await _exchange_authorization_code_for_credentials(
                    code, verifier, REDIRECT_URI
                )
            except RuntimeError as error:
                if not _is_retryable_login_error(error):
                    raise
                if on_progress:
                    on_progress(str(error))
                else:
                    print(f"\n{error}", file=sys.stderr)
                print(
                    "Paste the authorization code or full redirect URL again:",
                    file=sys.stderr,
                )
                code = None
    finally:
        await _cancel_login_task(manual_task)
        server.close()


async def refresh_openai_codex_token(refresh_token: str) -> OAuthCredentials:
    """Refresh OpenAI Codex OAuth token."""
    return _credentials_from_token(await _refresh_access_token(refresh_token))


class OpenAICodexOAuthProvider:
    id = "openai-codex"
    name = "ChatGPT Plus/Pro (Codex Subscription)"
    uses_callback_server = True

    async def login(self, callbacks: Any) -> OAuthCredentials:
        on_select = (
            callbacks.on_select if hasattr(callbacks, "on_select") else callbacks["onSelect"]
        )
        login_method = await on_select(
            {
                "message": "Select OpenAI Codex login method:",
                "options": [
                    {"id": OPENAI_CODEX_BROWSER_LOGIN_METHOD, "label": "Browser login (default)"},
                    {
                        "id": OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
                        "label": "Device code login (headless)",
                    },
                ],
            }
        )
        if not login_method:
            raise RuntimeError("Login cancelled")

        if login_method == OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD:
            on_device_code = (
                callbacks.on_device_code
                if hasattr(callbacks, "on_device_code")
                else callbacks["onDeviceCode"]
            )
            signal = callbacks.signal if hasattr(callbacks, "signal") else callbacks.get("signal")
            return await login_openai_codex_device_code(
                on_device_code=on_device_code, signal=signal
            )

        if login_method != OPENAI_CODEX_BROWSER_LOGIN_METHOD:
            raise RuntimeError(f"Unknown OpenAI Codex login method: {login_method}")

        on_auth = callbacks.on_auth if hasattr(callbacks, "on_auth") else callbacks["onAuth"]
        on_prompt = (
            callbacks.on_prompt if hasattr(callbacks, "on_prompt") else callbacks["onPrompt"]
        )
        on_progress = (
            callbacks.on_progress
            if hasattr(callbacks, "on_progress")
            else callbacks.get("onProgress")
        )
        on_manual_code_input = (
            callbacks.on_manual_code_input
            if hasattr(callbacks, "on_manual_code_input")
            else callbacks.get("onManualCodeInput")
        )
        return await login_openai_codex(
            on_auth=on_auth,
            on_prompt=on_prompt,
            on_progress=on_progress,
            on_manual_code_input=on_manual_code_input,
        )

    async def refresh_token(self, credentials: OAuthCredentials) -> OAuthCredentials:
        return await refresh_openai_codex_token(credentials["refresh"])

    def get_api_key(self, credentials: OAuthCredentials) -> str:
        return credentials["access"]

    def modify_models(self, models: list[Any], credentials: OAuthCredentials) -> list[Any]:
        return models


openai_codex_oauth_provider = OpenAICodexOAuthProvider()
