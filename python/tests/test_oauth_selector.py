"""Tests for OAuth selector and login provider classification."""

from __future__ import annotations


import pytest

from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.provider_display_names import BUILT_IN_PROVIDER_DISPLAY_NAMES
from pi_mono.coding_agent.modes.interactive.components.oauth_selector import (
    AuthSelectorProvider,
    OAuthSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.interactive_mode import is_api_key_login_provider
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.utils.ansi import strip_ansi


@pytest.fixture(autouse=True)
def _theme() -> None:
    init_theme("dark")


def test_is_api_key_login_provider() -> None:
    oauth_provider_ids = {"anthropic", "github-copilot", "custom-oauth"}
    built_in_provider_ids = {"anthropic", "github-copilot", "amazon-bedrock", "openai"}

    assert is_api_key_login_provider("anthropic", oauth_provider_ids, built_in_provider_ids) is True
    assert BUILT_IN_PROVIDER_DISPLAY_NAMES["anthropic"] == "Anthropic"
    assert is_api_key_login_provider("openai", oauth_provider_ids, built_in_provider_ids) is True
    assert (
        is_api_key_login_provider("github-copilot", oauth_provider_ids, built_in_provider_ids)
        is False
    )
    assert (
        is_api_key_login_provider("amazon-bedrock", oauth_provider_ids, built_in_provider_ids)
        is True
    )
    assert (
        is_api_key_login_provider("custom-oauth", oauth_provider_ids, built_in_provider_ids)
        is False
    )
    assert (
        is_api_key_login_provider("custom-api", oauth_provider_ids, built_in_provider_ids) is True
    )


def test_oauth_selector_shows_stored_oauth_distinctly() -> None:
    auth_storage = AuthStorage.in_memory(
        {
            "anthropic": {
                "type": "oauth",
                "access": "access-token",
                "refresh": "refresh-token",
                "expires": 9_999_999_999_999,
            }
        }
    )
    selector = OAuthSelectorComponent(
        "login",
        auth_storage,
        [AuthSelectorProvider(id="anthropic", name="Anthropic", auth_type="api_key")],
        lambda _provider_id: None,
        lambda: None,
    )
    output = strip_ansi("\n".join(selector.render(120)))
    assert "Anthropic" in output
    assert "subscription configured" in output


def test_oauth_selector_shows_environment_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    auth_storage = AuthStorage.in_memory()
    selector = OAuthSelectorComponent(
        "login",
        auth_storage,
        [AuthSelectorProvider(id="openai", name="OpenAI", auth_type="api_key")],
        lambda _provider_id: None,
        lambda: None,
        auth_storage.get_auth_status,
    )
    output = strip_ansi("\n".join(selector.render(120)))
    assert "OpenAI" in output
    assert "✓ env: OPENAI_API_KEY" in output
    assert "unconfigured" not in output


def test_oauth_selector_shows_custom_environment_status() -> None:
    auth_storage = AuthStorage.in_memory()
    selector = OAuthSelectorComponent(
        "login",
        auth_storage,
        [AuthSelectorProvider(id="ollama", name="ollama", auth_type="api_key")],
        lambda _provider_id: None,
        lambda: None,
        lambda _provider_id: {
            "configured": True,
            "source": "environment",
            "label": "OLLAMA_API_KEY",
        },
    )
    output = strip_ansi("\n".join(selector.render(120)))
    assert "ollama" in output
    assert "✓ env: OLLAMA_API_KEY" in output
    assert "unconfigured" not in output


def test_oauth_selector_shows_models_json_key_status() -> None:
    auth_storage = AuthStorage.in_memory()
    selector = OAuthSelectorComponent(
        "login",
        auth_storage,
        [AuthSelectorProvider(id="local-proxy", name="local-proxy", auth_type="api_key")],
        lambda _provider_id: None,
        lambda: None,
        lambda _provider_id: {"configured": True, "source": "models_json_key"},
    )
    output = strip_ansi("\n".join(selector.render(120)))
    assert "local-proxy" in output
    assert "✓ key in models.json" in output
    assert "unconfigured" not in output


def test_oauth_selector_shows_models_json_command_status() -> None:
    auth_storage = AuthStorage.in_memory()
    selector = OAuthSelectorComponent(
        "login",
        auth_storage,
        [AuthSelectorProvider(id="op-proxy", name="op-proxy", auth_type="api_key")],
        lambda _provider_id: None,
        lambda: None,
        lambda _provider_id: {"configured": True, "source": "models_json_command"},
    )
    output = strip_ansi("\n".join(selector.render(120)))
    assert "op-proxy" in output
    assert "✓ command in models.json" in output
    assert "unconfigured" not in output
