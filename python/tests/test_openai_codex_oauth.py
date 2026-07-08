import asyncio
import base64
import json
from unittest import mock

import pytest

from pi_mono.ai.utils.oauth.openai_codex import (
    _OAuthServerInfo,
    login_openai_codex,
    login_openai_codex_device_code,
    openai_codex_oauth_provider,
    refresh_openai_codex_token,
)


def _create_access_token(account_id: str) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = (
        base64.urlsafe_b64encode(
            json.dumps({"https://api.openai.com/auth": {"chatgpt_account_id": account_id}}).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"{header}.{payload}.signature"


class _AbortSignal:
    def __init__(self) -> None:
        self.aborted = False
        self._listeners: list = []

    def add_event_listener(self, event: str, callback) -> None:
        if event == "abort":
            self._listeners.append(callback)

    def abort(self) -> None:
        self.aborted = True
        for listener in self._listeners:
            listener()


def _response(status: int, body: dict | str, is_success: bool | None = None):
    response = mock.Mock()
    response.status_code = status
    response.is_success = is_success if is_success is not None else status < 400
    if isinstance(body, dict):
        response.text = json.dumps(body)
        response.json.return_value = body
    else:
        response.text = body
        response.json.side_effect = json.JSONDecodeError("err", body, 0)
    response.reason_phrase = "OK" if response.is_success else "Error"
    return response


@pytest.mark.anyio
async def test_logs_in_with_device_code_flow():
    access_token = _create_access_token("account-123")
    device_infos = []

    async def fake_fetch(url: str, init: dict, signal=None):
        if url == "https://auth.openai.com/oauth/token":
            return _response(
                200,
                {
                    "access_token": access_token,
                    "refresh_token": "refresh-token",
                    "expires_in": 3600,
                },
            )
        raise AssertionError(url)

    with (
        mock.patch(
            "pi_mono.ai.utils.oauth.openai_codex._start_openai_codex_device_auth",
            new_callable=mock.AsyncMock,
            return_value=mock.Mock(
                device_auth_id="device-auth-id",
                user_code="ABCD-1234",
                interval_seconds=5,
            ),
        ),
        mock.patch(
            "pi_mono.ai.utils.oauth.openai_codex._poll_openai_codex_device_auth",
            new_callable=mock.AsyncMock,
            return_value={
                "authorizationCode": "oauth-code",
                "codeVerifier": "device-code-verifier",
            },
        ),
        mock.patch(
            "pi_mono.ai.utils.oauth.openai_codex._fetch_with_login_cancellation",
            side_effect=fake_fetch,
        ),
    ):
        credentials = await login_openai_codex_device_code(
            on_device_code=device_infos.append,
        )

    assert credentials["access"] == access_token
    assert credentials["refresh"] == "refresh-token"
    assert credentials["accountId"] == "account-123"
    assert device_infos[0]["userCode"] == "ABCD-1234"


@pytest.mark.anyio
async def test_provider_uses_selected_device_code_flow():
    access_token = _create_access_token("account-456")
    select_prompts = []
    device_infos = []

    async def fake_fetch(url: str, init: dict, signal=None):
        if url == "https://auth.openai.com/api/accounts/deviceauth/usercode":
            return _response(
                200,
                {
                    "device_auth_id": "device-auth-id",
                    "user_code": "WXYZ-7890",
                    "interval": "5",
                },
            )
        if url == "https://auth.openai.com/api/accounts/deviceauth/token":
            return _response(
                200,
                {
                    "authorization_code": "oauth-code",
                    "code_verifier": "device-code-verifier",
                },
            )
        if url == "https://auth.openai.com/oauth/token":
            return _response(
                200,
                {
                    "access_token": access_token,
                    "refresh_token": "refresh-token",
                    "expires_in": 3600,
                },
            )
        raise AssertionError(url)

    with mock.patch(
        "pi_mono.ai.utils.oauth.openai_codex._fetch_with_login_cancellation",
        side_effect=fake_fetch,
    ):

        async def on_prompt(_: object) -> str:
            raise RuntimeError("prompt")

        async def on_select(prompt: dict) -> str:
            select_prompts.append(prompt)
            return "device_code"

        credentials = await openai_codex_oauth_provider.login(
            {
                "onAuth": lambda _: (_ for _ in ()).throw(RuntimeError("browser")),
                "onDeviceCode": device_infos.append,
                "onPrompt": on_prompt,
                "onSelect": on_select,
            }
        )

    assert credentials["accountId"] == "account-456"
    assert select_prompts[0]["message"] == "Select OpenAI Codex login method:"
    assert device_infos[0]["userCode"] == "WXYZ-7890"


@pytest.mark.anyio
async def test_cancels_when_login_method_selection_is_cancelled():
    with pytest.raises(RuntimeError, match="Login cancelled"):

        async def on_prompt(_: object) -> str:
            return ""

        async def on_select(_: dict) -> None:
            return None

        await openai_codex_oauth_provider.login(
            {
                "onAuth": lambda _: None,
                "onDeviceCode": lambda _: None,
                "onPrompt": on_prompt,
                "onSelect": on_select,
            }
        )


@pytest.mark.anyio
async def test_browser_callback_completes_without_waiting_for_manual_input():
    access_token = _create_access_token("account-browser")
    manual_started = asyncio.Event()
    manual_release = asyncio.Event()

    async def slow_manual_input() -> str:
        manual_started.set()
        await manual_release.wait()
        return "should-not-be-used"

    async def fake_start_server(state: str) -> _OAuthServerInfo:
        loop = asyncio.get_running_loop()
        result_future: asyncio.Future[dict[str, str] | None] = loop.create_future()

        def cancel_wait() -> None:
            if not result_future.done():
                result_future.set_result(None)

        async def complete_callback() -> None:
            await manual_started.wait()
            if not result_future.done():
                result_future.set_result({"code": "browser-code"})

        asyncio.create_task(complete_callback())
        return _OAuthServerInfo(
            server=None,
            cancel_wait=cancel_wait,
            wait_for_code=lambda: result_future,
        )

    async def fake_exchange(code: str, verifier: str, redirect_uri: str, signal=None):
        assert code == "browser-code"
        return {
            "access": access_token,
            "refresh": "refresh-token",
            "expires": 1_700_000_000_000,
            "accountId": "account-browser",
        }

    async def fail_prompt(_: object) -> str:
        pytest.fail("prompt should not be used")

    with (
        mock.patch(
            "pi_mono.ai.utils.oauth.openai_codex._start_local_oauth_server",
            side_effect=fake_start_server,
        ),
        mock.patch(
            "pi_mono.ai.utils.oauth.openai_codex._exchange_authorization_code_for_credentials",
            side_effect=fake_exchange,
        ),
    ):
        credentials = await login_openai_codex(
            on_auth=lambda _: None,
            on_prompt=fail_prompt,
            on_manual_code_input=slow_manual_input,
        )

    assert credentials["accountId"] == "account-browser"
    assert not manual_release.is_set()


@pytest.mark.anyio
async def test_retry_prompt_after_failed_exchange():
    access_token = _create_access_token("account-retry")
    prompt_inputs = iter(["bad-code", "good-code"])

    async def fake_start_server(state: str) -> _OAuthServerInfo:
        loop = asyncio.get_running_loop()
        result_future: asyncio.Future[dict[str, str] | None] = loop.create_future()
        result_future.set_result(None)
        return _OAuthServerInfo(
            server=None,
            cancel_wait=lambda: None,
            wait_for_code=lambda: result_future,
        )

    async def fake_exchange(code: str, verifier: str, redirect_uri: str, signal=None):
        if code == "good-code":
            return {
                "access": access_token,
                "refresh": "refresh-token",
                "expires": 1_700_000_000_000,
                "accountId": "account-retry",
            }
        raise RuntimeError("OpenAI Codex token exchange failed (400): invalid_grant")

    async def next_prompt(_: object) -> str:
        return next(prompt_inputs)

    with (
        mock.patch(
            "pi_mono.ai.utils.oauth.openai_codex._start_local_oauth_server",
            side_effect=fake_start_server,
        ),
        mock.patch(
            "pi_mono.ai.utils.oauth.openai_codex._exchange_authorization_code_for_credentials",
            side_effect=fake_exchange,
        ),
    ):
        credentials = await login_openai_codex(
            on_auth=lambda _: None,
            on_prompt=next_prompt,
        )

    assert credentials["accountId"] == "account-retry"


@pytest.mark.anyio
async def test_refresh_reports_http_error():
    with mock.patch("pi_mono.ai.utils.oauth.openai_codex.httpx.AsyncClient") as client_cls:
        client = client_cls.return_value.__aenter__.return_value
        client.post = mock.AsyncMock(
            return_value=_response(
                401,
                {
                    "error": {
                        "message": "Could not validate your token. Please try signing in again.",
                        "type": "invalid_request_error",
                    }
                },
            )
        )
        with pytest.raises(RuntimeError, match="OpenAI Codex token refresh failed"):
            await refresh_openai_codex_token("invalid-refresh-token")
