import json
from unittest import mock

import pytest

from pi_mono.ai.utils.oauth.github_copilot import login_github_copilot, normalize_domain


def _json_response(body: dict, status: int = 200):
    response = mock.Mock()
    response.is_success = status < 400
    response.status_code = status
    response.reason_phrase = "OK" if status < 400 else "Error"
    response.text = json.dumps(body)
    response.json.return_value = body
    return response


@pytest.mark.anyio
async def test_reports_device_code_details_through_on_device_code():
    device_infos = []

    async def fake_fetch_json(url: str, init: dict):
        if url.endswith("/login/device/code"):
            return {
                "device_code": "device-code",
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device",
                "interval": 1,
                "expires_in": 900,
            }
        if url.endswith("/login/oauth/access_token"):
            return {"access_token": "ghu_refresh_token"}
        if "/copilot_internal/v2/token" in url:
            return {
                "token": "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
                "expires_at": 9999999999,
            }
        if url.endswith("/models"):
            return {
                "data": [
                    {
                        "id": "gpt-4.1",
                        "model_picker_enabled": True,
                        "policy": {"state": "enabled"},
                        "capabilities": {"supports": {"tool_calls": True}},
                    }
                ]
            }
        raise AssertionError(f"Unexpected fetch URL: {url}")

    with (
        mock.patch(
            "pi_mono.ai.utils.oauth.github_copilot._fetch_json",
            side_effect=fake_fetch_json,
        ),
        mock.patch(
            "pi_mono.ai.utils.oauth.github_copilot._enable_all_github_copilot_models",
            new_callable=mock.AsyncMock,
        ),
    ):

        async def on_prompt(_: object) -> str:
            return ""

        await login_github_copilot(
            on_device_code=device_infos.append,
            on_prompt=on_prompt,
        )

    assert device_infos == [
        {
            "userCode": "ABCD-EFGH",
            "verificationUri": "https://github.com/login/device",
            "intervalSeconds": 1,
            "expiresInSeconds": 900,
        }
    ]


@pytest.mark.anyio
async def test_rejects_non_http_verification_uri():
    async def fake_fetch_json(url: str, init: dict):
        if url.endswith("/login/device/code"):
            return {
                "device_code": "device-code",
                "user_code": "ABCD-EFGH",
                "verification_uri": "$(id>/tmp/pwned)",
                "interval": 1,
                "expires_in": 900,
            }
        raise AssertionError(f"Unexpected fetch URL: {url}")

    with mock.patch(
        "pi_mono.ai.utils.oauth.github_copilot._fetch_json",
        side_effect=fake_fetch_json,
    ):
        with pytest.raises(RuntimeError, match="Untrusted verification_uri"):

            async def on_prompt(_: object) -> str:
                return ""

            await login_github_copilot(
                on_device_code=lambda _: None,
                on_prompt=on_prompt,
            )


def test_normalize_domain():
    assert normalize_domain("company.ghe.com") == "company.ghe.com"
    assert normalize_domain("https://company.ghe.com/path") == "company.ghe.com"
    assert normalize_domain("   ") is None
    assert normalize_domain("not a url!!!") is None
