"""Interactive Cursor auth UI regressions."""

from __future__ import annotations

from unittest import mock

from pi_mono.coding_agent.modes.interactive.components.oauth_selector import (
    AuthSelectorProvider,
    OAuthSelectorComponent,
)
from pi_mono.core.auth_storage import AuthStorage


class _Terminal:
    columns = 100
    rows = 24
    kittyProtocolActive = False


def test_oauth_selector_shows_cursor_cli_status() -> None:
    storage = AuthStorage.in_memory()
    selector = OAuthSelectorComponent(
        "login",
        storage,
        [AuthSelectorProvider(id="cursor", name="Cursor", auth_type="oauth")],
        lambda _provider_id: None,
        lambda: None,
    )

    with mock.patch("pi_mono.core.auth_storage.is_cursor_agent_authenticated", return_value=True):
        indicator = selector._format_status_indicator(
            AuthSelectorProvider(id="cursor", name="Cursor", auth_type="oauth")
        )

    assert "agent logged in" in indicator
