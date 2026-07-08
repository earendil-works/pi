"""Cursor Pro OAuth flow."""

from __future__ import annotations

import asyncio
import base64
import json
import time
import uuid
from typing import Any, List
from urllib.parse import urlencode

import httpx

from pi_mono.ai.utils.oauth.pkce import generate_pkce
from pi_mono.ai.utils.oauth.types import OAuthCredentials, OAuthLoginCallbacks
from pi_mono.ai.types import Model

CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl"
CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll"
CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key"


def get_token_expiry(token: str) -> int:
    try:
        parts = token.split(".")
        if len(parts) == 3 and parts[1]:
            # pad base64
            padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
            decoded = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
            if isinstance(decoded, dict) and "exp" in decoded:
                return int(decoded["exp"]) * 1000 - 5 * 60 * 1000
    except Exception:
        pass
    return int(time.time() * 1000) + 3600 * 1000


async def poll_cursor_auth(auth_uuid: str, verifier: str) -> dict[str, str]:
    delay = 1.0
    consecutive_errors = 0

    async with httpx.AsyncClient(timeout=10.0) as client:
        for _ in range(150):
            await asyncio.sleep(delay)
            try:
                response = await client.get(
                    f"{CURSOR_POLL_URL}?uuid={auth_uuid}&verifier={verifier}"
                )
                if response.status_code == 404:
                    consecutive_errors = 0
                    delay = min(delay * 1.2, 10.0)
                    continue
                if response.status_code == 200:
                    data = response.json()
                    return {
                        "accessToken": data["accessToken"],
                        "refreshToken": data["refreshToken"],
                    }
                raise RuntimeError(f"Poll failed with status code: {response.status_code}")
            except Exception as e:
                consecutive_errors += 1
                if consecutive_errors >= 3:
                    raise RuntimeError(
                        f"Too many consecutive errors during Cursor auth polling: {e}"
                    )
    raise RuntimeError("Cursor authentication polling timeout")


async def refresh_cursor_token(refresh_token: str) -> OAuthCredentials:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            CURSOR_REFRESH_URL,
            headers={
                "Authorization": f"Bearer {refresh_token}",
                "Content-Type": "application/json",
            },
            json={},
        )
        if response.status_code != 200:
            raise RuntimeError(f"Cursor token refresh failed: {response.text}")
        data = response.json()
        return {
            "refresh": data.get("refreshToken") or refresh_token,
            "access": data["accessToken"],
            "expires": get_token_expiry(data["accessToken"]),
        }


class CursorOAuthProvider:
    id = "cursor"
    name = "Cursor"
    uses_callback_server = False

    async def login(self, callbacks: OAuthLoginCallbacks) -> OAuthCredentials:
        pkce = await generate_pkce()
        verifier = pkce["verifier"]
        challenge = pkce["challenge"]
        auth_uuid = str(uuid.uuid4())

        params = urlencode(
            {
                "challenge": challenge,
                "uuid": auth_uuid,
                "mode": "login",
                "redirectTarget": "cli",
            }
        )

        login_url = f"{CURSOR_LOGIN_URL}?{params}"

        callbacks_any: Any = callbacks
        on_auth = (
            callbacks_any.on_auth
            if hasattr(callbacks_any, "on_auth")
            else callbacks_any.get("onAuth")
        )
        if on_auth:
            on_auth(
                {
                    "url": login_url,
                    "instructions": "Complete login in your browser. This window will poll for credentials.",
                }
            )

        auth_data = await poll_cursor_auth(auth_uuid, verifier)
        access_token = auth_data["accessToken"]
        refresh_token = auth_data["refreshToken"]

        return {
            "refresh": refresh_token,
            "access": access_token,
            "expires": get_token_expiry(access_token),
        }

    async def refresh_token(self, credentials: OAuthCredentials) -> OAuthCredentials:
        return await refresh_cursor_token(credentials.get("refresh") or "")

    def get_api_key(self, credentials: OAuthCredentials) -> str:
        return credentials.get("access") or ""

    def modify_models(self, models: List[Model], credentials: OAuthCredentials) -> List[Model]:
        return models


cursor_oauth_provider = CursorOAuthProvider()
