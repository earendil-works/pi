from __future__ import annotations

import asyncio
from unittest import mock

from pi_mono.core.auth_storage import AuthStorage


def test_cursor_has_auth_uses_agent_status() -> None:
    storage = AuthStorage.in_memory()

    with mock.patch("pi_mono.core.auth_storage.is_cursor_agent_authenticated", return_value=True):
        assert storage.has_auth("cursor") is True
        assert storage.get_auth_status("cursor") == {
            "configured": True,
            "source": "cursor_cli",
            "label": "agent status",
        }


def test_cursor_has_auth_uses_env_key(monkeypatch) -> None:
    storage = AuthStorage.in_memory()
    monkeypatch.setenv("CURSOR_API_KEY", "cursor-key")

    assert storage.has_auth("cursor") is True
    assert storage.get_auth_status("cursor") == {
        "configured": False,
        "source": "environment",
        "label": "CURSOR_API_KEY",
    }


def test_cursor_get_api_key_uses_stored_api_key_when_cli_is_not_authenticated() -> None:
    storage = AuthStorage.in_memory({"cursor": {"type": "api_key", "key": "cursor-sdk-key"}})

    with mock.patch("pi_mono.core.auth_storage.is_cursor_agent_authenticated", return_value=False):
        assert storage.get_auth_status("cursor") == {"configured": True, "source": "stored"}
        api_key = asyncio.run(storage.get_api_key("cursor"))

    assert api_key == "cursor-sdk-key"


def test_cursor_get_api_key_ignores_stored_api_key_when_cli_is_authenticated() -> None:
    storage = AuthStorage.in_memory({"cursor": {"type": "api_key", "key": "dummy-key"}})

    with mock.patch("pi_mono.core.auth_storage.is_cursor_agent_authenticated", return_value=True):
        assert storage.get_auth_status("cursor") == {
            "configured": True,
            "source": "cursor_cli",
            "label": "agent status",
        }
        api_key = asyncio.run(storage.get_api_key("cursor"))

    assert api_key is None


def test_cursor_model_registry_treats_authenticated_cli_as_ready() -> None:
    storage = AuthStorage.in_memory()
    with mock.patch("pi_mono.core.auth_storage.is_cursor_agent_authenticated", return_value=True):
        from pi_mono.core.model_registry import ModelRegistry

        registry = ModelRegistry.in_memory(storage)
        cursor_models = [
            model for model in registry.get_available() if model["provider"] == "cursor"
        ]
        assert cursor_models
        auth = asyncio.run(registry.get_api_key_and_headers(cursor_models[0]))
        assert auth["ok"] is True
        assert auth["apiKey"] == "<authenticated>"
