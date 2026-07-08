"""Cursor CLI auth warning helpers."""

from __future__ import annotations

from unittest import mock

from pi_mono.coding_agent.core.cursor_auth import (
    CURSOR_CLI_LOGIN_HINT,
    clear_stale_cursor_oauth,
    get_cursor_auth_warning,
)
from pi_mono.core.auth_storage import AuthStorage


def test_get_cursor_auth_warning_for_stale_oauth() -> None:
    storage = AuthStorage.in_memory()
    storage.set("cursor", {"type": "oauth", "access": "old-token"})

    with mock.patch("pi_mono.coding_agent.core.cursor_auth.is_cursor_agent_authenticated", return_value=False):
        assert get_cursor_auth_warning(storage) == CURSOR_CLI_LOGIN_HINT


def test_get_cursor_auth_warning_none_when_cli_authenticated() -> None:
    storage = AuthStorage.in_memory()
    storage.set("cursor", {"type": "oauth", "access": "old-token"})

    with mock.patch("pi_mono.coding_agent.core.cursor_auth.is_cursor_agent_authenticated", return_value=True):
        assert get_cursor_auth_warning(storage) is None


def test_clear_stale_cursor_oauth_removes_oauth_entry() -> None:
    storage = AuthStorage.in_memory()
    storage.set("cursor", {"type": "oauth", "access": "old-token"})

    assert clear_stale_cursor_oauth(storage) is True
    assert storage.get("cursor") is None


def test_clear_stale_cursor_oauth_ignores_api_key() -> None:
    storage = AuthStorage.in_memory()
    storage.set("cursor", {"type": "api_key", "key": "keep-me"})

    assert clear_stale_cursor_oauth(storage) is False
    assert storage.get("cursor") == {"type": "api_key", "key": "keep-me"}
