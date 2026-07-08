"""P4 feature parity tests: clipboard, model selector, footer, fuzzy."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest


from pi_mono.coding_agent.core.experimental import are_experimental_features_enabled
from pi_mono.coding_agent.core.model_resolver import find_exact_model_reference_match
from pi_mono.coding_agent.modes.interactive.components.footer import FooterComponent
from pi_mono.coding_agent.modes.interactive.components.model_selector import ModelSelectorComponent
from pi_mono.coding_agent.utils.clipboard_image import (
    ClipboardImage,
    read_clipboard_image,
)
from pi_mono.tui.fuzzy import fuzzy_filter


def test_fuzzy_filter_splits_on_slash() -> None:
    items = ["openai/gpt-5", "anthropic/claude"]
    assert fuzzy_filter(items, "openai/gpt", lambda item: item) == ["openai/gpt-5"]
    assert fuzzy_filter(items, "anthropic/claude", lambda item: item) == ["anthropic/claude"]


def test_find_exact_model_reference_match() -> None:
    models = [
        {"provider": "openai", "id": "gpt-5"},
        {"provider": "anthropic", "id": "claude-opus-4-8"},
    ]
    assert find_exact_model_reference_match("openai/gpt-5", models) == models[0]
    assert find_exact_model_reference_match("gpt-5", models) == models[0]
    assert find_exact_model_reference_match("missing", models) is None


def test_read_clipboard_image_termux_is_noop() -> None:
    assert read_clipboard_image(env={"TERMUX_VERSION": "0.118.0"}, platform="linux") is None


def test_read_clipboard_image_win32_powershell(monkeypatch) -> None:
    png_bytes = b"\x89PNG\r\n\x1a\n"

    def fake_read() -> ClipboardImage:
        return ClipboardImage(bytes=png_bytes, mime_type="image/png")

    monkeypatch.setattr(
        "pi_mono.coding_agent.utils.clipboard_image._read_clipboard_image_via_win32_powershell",
        fake_read,
    )
    image = read_clipboard_image(env={}, platform="win32")
    assert image == ClipboardImage(bytes=png_bytes, mime_type="image/png")


def test_footer_shows_experimental_marker(monkeypatch) -> None:
    monkeypatch.setenv("PI_EXPERIMENTAL", "1")
    assert are_experimental_features_enabled()

    session = MagicMock()
    session.state.model = {"id": "gpt-5", "provider": "openai", "contextWindow": 128000}
    session.state.thinkingLevel = "off"
    session.get_context_usage.return_value = {"percent": 10.0, "contextWindow": 128000}
    session.model_registry = None

    footer_data = MagicMock()
    footer_data.get_git_branch.return_value = None
    footer_data.get_extension_statuses.return_value = {}
    footer_data.get_available_provider_count.return_value = 1
    footer_data.get_token_stats.return_value = MagicMock(
        input=100,
        output=50,
        cache_read=0,
        cache_write=0,
        total_cost=0.0,
    )

    session.session_manager.get_cwd.return_value = "/tmp"
    session.session_manager.get_session_name.return_value = None

    footer = FooterComponent(session, footer_data)
    lines = footer.render(120)
    assert any("xp" in line for line in lines)


def test_model_selector_defaults_to_scoped_tab() -> None:
    ui = MagicMock()
    registry = MagicMock()
    registry.refresh.return_value = None
    registry.get_error.return_value = None
    registry.has_configured_auth.return_value = True
    registry.get_available.return_value = [
        {"provider": "openai", "id": "gpt-5"},
        {"provider": "anthropic", "id": "claude-opus-4-8"},
    ]
    registry.find.side_effect = lambda provider, model_id: {
        "provider": provider,
        "id": model_id,
    }

    settings = MagicMock()
    selector = ModelSelectorComponent(
        ui,
        {"provider": "openai", "id": "gpt-5"},
        settings,
        registry,
        lambda _model: None,
        lambda: None,
        scoped_models=[{"model": {"provider": "openai", "id": "gpt-5"}}],
    )
    assert selector._scope == "scoped"
    assert len(selector._filtered_models) == 1


def test_model_selector_falls_back_to_all_when_scoped_is_empty() -> None:
    ui = MagicMock()
    registry = MagicMock()
    registry.refresh.return_value = None
    registry.get_error.return_value = None
    registry.has_configured_auth.return_value = False
    registry.get_available.return_value = [
        {"provider": "cursor", "id": "auto"},
        {"provider": "cursor", "id": "composer-2.5"},
    ]

    settings = MagicMock()
    selector = ModelSelectorComponent(
        ui,
        {"provider": "cursor", "id": "auto"},
        settings,
        registry,
        lambda _model: None,
        lambda: None,
        scoped_models=[{"model": {"provider": "openrouter", "id": "gpt-4o"}}],
    )
    assert selector._scope == "all"
    assert len(selector._filtered_models) == 2


def test_model_selector_selects_from_loaded_models() -> None:
    ui = MagicMock()
    registry = MagicMock()
    registry.refresh.return_value = None
    registry.get_error.return_value = None
    registry.has_configured_auth.return_value = True
    cursor_model = {"provider": "cursor", "id": "auto"}
    registry.get_available.return_value = [cursor_model]
    registry.find.return_value = None

    selected: list[dict[str, str]] = []
    settings = MagicMock()
    selector = ModelSelectorComponent(
        ui,
        None,
        settings,
        registry,
        lambda model: selected.append(model),
        lambda: None,
    )
    selector._handle_select(cursor_model)
    assert selected == [cursor_model]


def test_model_selector_arrow_down_advances_selection(tmp_path) -> None:
    from pi_mono.coding_agent.core.keybindings import CodingAgentKeybindingsManager
    from pi_mono.tui.keybindings import set_keybindings

    set_keybindings(CodingAgentKeybindingsManager.create(str(tmp_path / "agent")))
    ui = MagicMock()
    registry = MagicMock()
    registry.refresh.return_value = None
    registry.get_error.return_value = None
    registry.has_configured_auth.return_value = True
    registry.get_available.return_value = [
        {"provider": "faux", "id": "one"},
        {"provider": "faux", "id": "two"},
    ]
    registry.find.return_value = None
    selector = ModelSelectorComponent(
        ui,
        None,
        MagicMock(),
        registry,
        lambda _model: None,
        lambda: None,
    )
    assert selector._selected_index == 0
    selector.handle_input("\x1b[B")
    assert selector._selected_index == 1


@pytest.mark.anyio
async def test_model_selector_loads_models_in_background() -> None:
    import threading

    ui = MagicMock()
    registry = MagicMock()
    gate = threading.Event()

    def blocking_refresh() -> None:
        gate.wait(timeout=1.0)

    registry.refresh.side_effect = blocking_refresh
    registry.get_error.return_value = None
    registry.has_configured_auth.return_value = True
    registry.get_available.return_value = [{"provider": "cursor", "id": "auto"}]
    registry.find.return_value = None

    selector = ModelSelectorComponent(
        ui,
        None,
        MagicMock(),
        registry,
        lambda _model: None,
        lambda: None,
    )
    assert selector._loading is True

    gate.set()
    for _ in range(50):
        if not selector._loading:
            break
        await asyncio.sleep(0.02)

    assert not selector._loading
    assert selector._filtered_models == [{"provider": "cursor", "id": "auto"}]
