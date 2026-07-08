"""Issue #5433: extension OAuth prompt input stays stable across stacked prompts."""

from __future__ import annotations

import pytest

from pi_mono.coding_agent.core.keybindings import CodingAgentKeybindingsManager
from pi_mono.coding_agent.modes.interactive.components.login_dialog import LoginDialogComponent
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.tui.keybindings import set_keybindings
from pi_mono.utils.ansi import strip_ansi
from unittest.mock import MagicMock


@pytest.fixture(autouse=True)
def _init_theme() -> None:
    init_theme("dark")


def _create_dialog() -> LoginDialogComponent:
    return LoginDialogComponent(
        MagicMock(),
        "prompt-repro",
        lambda _success, _message=None: None,
        title="Prompt Repro",
    )


def _set_test_keybindings(tmp_path) -> None:
    set_keybindings(CodingAgentKeybindingsManager.create(str(tmp_path / "agent")))


def _render_lines(dialog: LoginDialogComponent) -> list[str]:
    return [strip_ansi(line).rstrip() for line in dialog.render(120)]


def _count_rendered_value(lines: list[str], value: str) -> int:
    return sum(1 for line in lines if line.strip() == f"> {value}")


@pytest.mark.anyio
async def test_keeps_previous_prompt_input_stable_when_later_prompt_is_active(tmp_path) -> None:
    _set_test_keybindings(tmp_path)
    dialog = _create_dialog()

    first_prompt = dialog.show_prompt("First prompt:", "first-value")
    dialog.handle_input("first-value")
    dialog.handle_input("\n")
    assert await first_prompt == "first-value"

    second_prompt = dialog.show_prompt("Second prompt:")
    dialog.handle_input("second-secret-demo")

    lines = _render_lines(dialog)
    rendered = "\n".join(lines)
    assert "First prompt:" in rendered
    assert "Second prompt:" in rendered
    assert _count_rendered_value(lines, "first-value") == 1
    assert _count_rendered_value(lines, "second-secret-demo") == 1

    dialog.handle_input("\n")
    assert await second_prompt == "second-secret-demo"


def test_preserves_auth_instructions_when_showing_prompt(tmp_path, monkeypatch) -> None:
    _set_test_keybindings(tmp_path)
    dialog = _create_dialog()
    monkeypatch.setattr(
        "pi_mono.coding_agent.modes.interactive.components.login_dialog.open_browser",
        lambda _url: None,
    )

    dialog.show_auth("https://example.invalid/login", "Authorize the extension")
    dialog.show_prompt("First prompt:")

    output = "\n".join(_render_lines(dialog))
    assert "https://example.invalid/login" in output
    assert "Authorize the extension" in output
    assert "First prompt:" in output


@pytest.mark.anyio
async def test_keeps_previous_manual_input_stable_when_later_prompt_is_active(tmp_path) -> None:
    _set_test_keybindings(tmp_path)
    dialog = _create_dialog()

    manual_input = dialog.show_manual_input("Paste callback URL:")
    dialog.handle_input("callback-value")
    dialog.handle_input("\n")
    assert await manual_input == "callback-value"

    prompt = dialog.show_prompt("Second prompt:")
    dialog.handle_input("second-secret-demo")

    lines = _render_lines(dialog)
    rendered = "\n".join(lines)
    assert "Paste callback URL:" in rendered
    assert "Second prompt:" in rendered
    assert _count_rendered_value(lines, "callback-value") == 1
    assert _count_rendered_value(lines, "second-secret-demo") == 1

    dialog.handle_input("\n")
    assert await prompt == "second-secret-demo"
