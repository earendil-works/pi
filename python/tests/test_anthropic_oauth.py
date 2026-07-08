import json
from unittest import mock

import pytest

from pi_mono.ai.utils.oauth.anthropic import login_anthropic, refresh_anthropic_token


class _FakeCallbackServer:
    def __init__(self) -> None:
        self.server = mock.Mock()

    def cancel_wait(self) -> None:
        pass

    async def wait_for_code(self):
        return None


@pytest.mark.anyio
async def test_keeps_localhost_redirect_uri_for_manual_callback_login():
    auth_url = {"value": ""}

    async def fake_start_callback_server(_expected_state: str):
        return _FakeCallbackServer()

    with (
        mock.patch(
            "pi_mono.ai.utils.oauth.anthropic._start_callback_server",
            side_effect=fake_start_callback_server,
        ),
        mock.patch(
            "pi_mono.ai.utils.oauth.anthropic._post_json",
            new_callable=mock.AsyncMock,
        ) as post_json,
    ):
        post_json.return_value = json.dumps(
            {
                "access_token": "access-token",
                "refresh_token": "refresh-token",
                "expires_in": 3600,
            }
        )

        async def on_manual_code_input():
            from urllib.parse import parse_qs, urlparse

            parsed = urlparse(auth_url["value"])
            params = parse_qs(parsed.query)
            state = params["state"][0]
            redirect_uri = params["redirect_uri"][0]
            return f"{redirect_uri}?code=manual-code&state={state}"

        async def on_prompt(_: object) -> str:
            return ""

        credentials = await login_anthropic(
            on_auth=lambda info: auth_url.update(value=info["url"]),
            on_prompt=on_prompt,
            on_manual_code_input=on_manual_code_input,
        )

    assert credentials["access"] == "access-token"
    assert credentials["refresh"] == "refresh-token"
    body = post_json.await_args.args[1]
    assert body["grant_type"] == "authorization_code"
    assert body["code"] == "manual-code"
    assert body["redirect_uri"] == "http://localhost:53692/callback"


@pytest.mark.anyio
async def test_omits_scope_from_refresh_token_requests():
    with mock.patch(
        "pi_mono.ai.utils.oauth.anthropic._post_json",
        new_callable=mock.AsyncMock,
    ) as post_json:
        post_json.return_value = json.dumps(
            {
                "access_token": "new-access-token",
                "refresh_token": "new-refresh-token",
                "expires_in": 3600,
            }
        )

        credentials = await refresh_anthropic_token("refresh-token")

    assert credentials["access"] == "new-access-token"
    assert credentials["refresh"] == "new-refresh-token"
    body = post_json.await_args.args[1]
    assert body["grant_type"] == "refresh_token"
    assert body["refresh_token"] == "refresh-token"
    assert "scope" not in body
