"""Issue #3217: scoped model ordering and search ranking."""

from __future__ import annotations

from unittest.mock import MagicMock

from pi_mono.coding_agent.core.keybindings import CodingAgentKeybindingsManager
from pi_mono.coding_agent.modes.interactive.components.scoped_models_selector import (
    ScopedModelsSelectorComponent,
)
from pi_mono.tui.keybindings import set_keybindings


class _FakeModel:
    def __init__(self, model_id: str, provider: str = "faux", name: str | None = None) -> None:
        self._data = {"id": model_id, "provider": provider, "name": name or model_id}

    def get(self, key: str, default: object = None) -> object:
        return self._data.get(key, default)


def test_scoped_models_selector_reorder_propagates_change(tmp_path) -> None:
    set_keybindings(CodingAgentKeybindingsManager.create(str(tmp_path / "agent")))
    models = [_FakeModel("faux-1"), _FakeModel("faux-2"), _FakeModel("faux-3")]
    changes: list[list[str] | None] = []
    selector = ScopedModelsSelectorComponent(
        MagicMock(),
        models,  # type: ignore[arg-type]
        [f"faux/{model.get('id')}" for model in models],
        on_change=lambda enabled: changes.append(enabled),
        on_persist=lambda _enabled: None,
        on_cancel=lambda: None,
    )
    selector.handle_input("\x1bn")
    assert changes == [["faux/faux-2", "faux/faux-1", "faux/faux-3"]]


def test_scoped_models_selector_arrow_down_moves_selection(tmp_path) -> None:
    set_keybindings(CodingAgentKeybindingsManager.create(str(tmp_path / "agent")))
    models = [_FakeModel("faux-1"), _FakeModel("faux-2")]
    selector = ScopedModelsSelectorComponent(
        MagicMock(),
        models,  # type: ignore[arg-type]
        None,
        on_change=lambda _enabled: None,
        on_persist=lambda _enabled: None,
        on_cancel=lambda: None,
    )
    assert selector._selected_index == 0
    selector.handle_input("\x1b[B")
    assert selector._selected_index == 1


def test_model_selector_search_text_prefers_provider_prefix() -> None:
    from pi_mono.coding_agent.modes.interactive.model_search import get_model_selector_search_text

    class Item:
        id = "openai/gpt-5"
        provider = "openrouter"
        name = "GPT-5"

    text = get_model_selector_search_text(Item())
    assert text.index("openrouter") < text.index("openai/gpt-5")
