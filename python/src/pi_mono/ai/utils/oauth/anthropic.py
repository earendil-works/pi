"""Anthropic OAuth flow (Claude Pro/Max)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

import httpx

from pi_mono.ai.utils.oauth.oauth_page import oauth_error_html, oauth_success_html
from pi_mono.ai.utils.oauth.pkce import generate_pkce
from pi_mono.ai.utils.oauth.types import OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt

CLIENT_ID = base64.b64decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl").decode("ascii")
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CALLBACK_HOST = os.environ.get("PI_OAUTH_CALLBACK_HOST", "127.0.0.1")
CALLBACK_PORT = 53692
CALLBACK_PATH = "/callback"
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}"
SCOPES = (
    "org:create_api_key user:profile user:inference user:sessions:claude_code "
    "user:mcp_servers user:file_upload"
)


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


def _format_error_details(error: BaseException) -> str:
    details = [f"{type(error).__name__}: {error}"]
    code = getattr(error, "code", None)
    if code:
        details.append(f"code={code}")
    errno = getattr(error, "errno", None)
    if errno is not None:
        details.append(f"errno={errno}")
    cause = getattr(error, "__cause__", None)
    if cause is not None:
        details.append(
            f"cause={_format_error_details(cause) if isinstance(cause, BaseException) else cause}"
        )
    return "; ".join(details)


class _CallbackServerInfo:
    def __init__(
        self,
        server: HTTPServer,
        redirect_uri: str,
        cancel_wait: Callable[[], None],
        wait_for_code: Callable[[], Any],
    ) -> None:
        self.server = server
        self.redirect_uri = redirect_uri
        self.cancel_wait = cancel_wait
        self.wait_for_code = wait_for_code


async def _start_callback_server(expected_state: str) -> _CallbackServerInfo:
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
                if parsed.path != CALLBACK_PATH:
                    self._send_html(404, oauth_error_html("Callback route not found."))
                    return

                params = parse_qs(parsed.query)
                code = params.get("code", [None])[0]
                state = params.get("state", [None])[0]
                error = params.get("error", [None])[0]

                if error:
                    self._send_html(
                        400,
                        oauth_error_html(
                            "Anthropic authentication did not complete.",
                            f"Error: {error}",
                        ),
                    )
                    return

                if not code or not state:
                    self._send_html(400, oauth_error_html("Missing code or state parameter."))
                    return

                if state != expected_state:
                    self._send_html(400, oauth_error_html("State mismatch."))
                    return

                self._send_html(
                    200,
                    oauth_success_html(
                        "Anthropic authentication completed. You can close this window."
                    ),
                )
                settle_wait({"code": code, "state": state})
            except Exception:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"Internal error")

        def _send_html(self, status: int, body: str) -> None:
            encoded = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = HTTPServer((CALLBACK_HOST, CALLBACK_PORT), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    return _CallbackServerInfo(
        server=server,
        redirect_uri=REDIRECT_URI,
        cancel_wait=lambda: settle_wait(None),
        wait_for_code=lambda: result_future,
    )


async def _post_json(url: str, body: dict[str, str | int]) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=body,
        )
        response_body = response.text
        if not response.is_success:
            raise RuntimeError(
                f"HTTP request failed. status={response.status_code}; url={url}; body={response_body}"
            )
        return response_body


async def _exchange_authorization_code(
    code: str,
    state: str,
    verifier: str,
    redirect_uri: str,
) -> OAuthCredentials:
    try:
        response_body = await _post_json(
            TOKEN_URL,
            {
                "grant_type": "authorization_code",
                "client_id": CLIENT_ID,
                "code": code,
                "state": state,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
        )
    except Exception as error:
        raise RuntimeError(
            "Token exchange request failed. "
            f"url={TOKEN_URL}; redirect_uri={redirect_uri}; response_type=authorization_code; "
            f"details={_format_error_details(error if isinstance(error, BaseException) else Exception(str(error)))}"
        ) from error

    try:
        token_data = json.loads(response_body)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Token exchange returned invalid JSON. url={TOKEN_URL}; body={response_body}; "
            f"details={_format_error_details(error)}"
        ) from error

    expires_in = int(token_data["expires_in"])
    return {
        "refresh": token_data["refresh_token"],
        "access": token_data["access_token"],
        "expires": int(time.time() * 1000) + expires_in * 1000 - 5 * 60 * 1000,
    }


async def login_anthropic(
    *,
    on_auth: Callable[[dict[str, str]], None],
    on_prompt: Callable[[OAuthPrompt], Any],
    on_progress: Callable[[str], None] | None = None,
    on_manual_code_input: Callable[[], Any] | None = None,
) -> OAuthCredentials:
    """Login with Anthropic OAuth (authorization code + PKCE)."""
    pkce = await generate_pkce()
    verifier = pkce["verifier"]
    challenge = pkce["challenge"]
    server = await _start_callback_server(verifier)

    code: str | None = None
    state: str | None = None
    redirect_uri_for_exchange = REDIRECT_URI

    try:
        from urllib.parse import urlencode

        auth_params = urlencode(
            {
                "code": "true",
                "client_id": CLIENT_ID,
                "response_type": "code",
                "redirect_uri": REDIRECT_URI,
                "scope": SCOPES,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": verifier,
            }
        )
        on_auth(
            {
                "url": f"{AUTHORIZE_URL}?{auth_params}",
                "instructions": (
                    "Complete login in your browser. If the browser is on another machine, "
                    "paste the final redirect URL here."
                ),
            }
        )

        manual_input: str | None = None
        manual_error: BaseException | None = None

        manual_task = None
        if on_manual_code_input is not None:

            async def _run_manual() -> None:
                nonlocal manual_input, manual_error
                try:
                    manual_input = await on_manual_code_input()
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
                state = result["state"]
                redirect_uri_for_exchange = REDIRECT_URI
            elif manual_input:
                parsed = _parse_authorization_input(manual_input)
                if parsed.get("state") and parsed["state"] != verifier:
                    raise RuntimeError("OAuth state mismatch")
                code = parsed.get("code")
                state = parsed.get("state") or verifier

            if not code:
                if not manual_task.done():
                    await manual_task
                if manual_error is not None:
                    raise manual_error
                if manual_input:
                    parsed = _parse_authorization_input(manual_input)
                    if parsed.get("state") and parsed["state"] != verifier:
                        raise RuntimeError("OAuth state mismatch")
                    code = parsed.get("code")
                    state = parsed.get("state") or verifier
        else:
            result = await server.wait_for_code()
            if result and result.get("code"):
                code = result["code"]
                state = result["state"]
                redirect_uri_for_exchange = REDIRECT_URI

        if not code:
            prompt_input = await on_prompt(
                {
                    "message": "Paste the authorization code or full redirect URL:",
                    "placeholder": REDIRECT_URI,
                }
            )
            parsed = _parse_authorization_input(prompt_input)
            if parsed.get("state") and parsed["state"] != verifier:
                raise RuntimeError("OAuth state mismatch")
            code = parsed.get("code")
            state = parsed.get("state") or verifier

        if not code:
            raise RuntimeError("Missing authorization code")
        if not state:
            raise RuntimeError("Missing OAuth state")

        if on_progress:
            on_progress("Exchanging authorization code for tokens...")
        return await _exchange_authorization_code(code, state, verifier, redirect_uri_for_exchange)
    finally:
        if manual_task is not None and not manual_task.done():
            manual_task.cancel()
            try:
                await manual_task
            except asyncio.CancelledError:
                pass
        server.server.shutdown()


async def refresh_anthropic_token(refresh_token: str) -> OAuthCredentials:
    """Refresh Anthropic OAuth token."""
    try:
        response_body = await _post_json(
            TOKEN_URL,
            {
                "grant_type": "refresh_token",
                "client_id": CLIENT_ID,
                "refresh_token": refresh_token,
            },
        )
    except Exception as error:
        raise RuntimeError(
            f"Anthropic token refresh request failed. url={TOKEN_URL}; "
            f"details={_format_error_details(error if isinstance(error, BaseException) else Exception(str(error)))}"
        ) from error

    try:
        data = json.loads(response_body)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Anthropic token refresh returned invalid JSON. url={TOKEN_URL}; body={response_body}; "
            f"details={_format_error_details(error)}"
        ) from error

    expires_in = int(data["expires_in"])
    return {
        "refresh": data["refresh_token"],
        "access": data["access_token"],
        "expires": int(time.time() * 1000) + expires_in * 1000 - 5 * 60 * 1000,
    }


class AnthropicOAuthProvider:
    id = "anthropic"
    name = "Anthropic (Claude Pro/Max)"
    uses_callback_server = True

    async def login(self, callbacks: OAuthLoginCallbacks) -> OAuthCredentials:
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
        return await login_anthropic(
            on_auth=on_auth,
            on_prompt=on_prompt,
            on_progress=on_progress,
            on_manual_code_input=on_manual_code_input,
        )

    async def refresh_token(self, credentials: OAuthCredentials) -> OAuthCredentials:
        return await refresh_anthropic_token(credentials["refresh"])

    def get_api_key(self, credentials: OAuthCredentials) -> str:
        return credentials["access"]

    def modify_models(self, models: list[Any], credentials: OAuthCredentials) -> list[Any]:
        return models


anthropic_oauth_provider = AnthropicOAuthProvider()
