"""Interactive UI component width and behavior tests (Phase 5)."""

from __future__ import annotations


from pi_mono.coding_agent.modes.interactive.components.extension_input import (
    ExtensionInputComponent,
)
from pi_mono.coding_agent.modes.interactive.components.show_images_selector import (
    ShowImagesSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.components.tool_execution import (
    ToolExecutionComponent,
)
from pi_mono.coding_agent.modes.interactive.components.user_message_selector import (
    UserMessageSelectorComponent,
)
from pi_mono.coding_agent.modes.interactive.theme.theme import init_theme
from pi_mono.tui.utils import visible_width
from pi_mono.utils.ansi import strip_ansi


def test_tool_execution_edit_diff_keeps_lines_within_width() -> None:
    init_theme()
    long_text = "模" * 40
    diff = f"-  1 {long_text}\n+  1 {long_text}changed"
    component = ToolExecutionComponent(
        "edit",
        "tool-edit-1",
        {"path": "example.txt"},
        cwd="/tmp",
    )
    component.update_result(
        {"content": [{"type": "text", "text": "ok"}], "details": {"diff": diff}},
        is_partial=False,
    )
    component.set_expanded(True)

    for line in component.render(60):
        assert visible_width(line) <= 60


def test_show_images_selector_keeps_lines_within_width() -> None:
    init_theme()
    selected: list[bool] = []

    component = ShowImagesSelectorComponent(
        current_value=True,
        on_select=selected.append,
        on_cancel=lambda: None,
    )

    for line in component.render(40):
        assert visible_width(line) <= 40


def test_user_message_selector_keeps_lines_within_width() -> None:
    init_theme()
    messages = [
        {"id": "entry-1", "text": "한글" * 30},
        {"id": "entry-2", "text": "second message"},
    ]
    component = UserMessageSelectorComponent(
        messages,
        on_select=lambda _entry_id: None,
        on_cancel=lambda: None,
        initial_selected_id="entry-2",
    )

    for line in component.render(50):
        assert visible_width(line) <= 50


def test_user_message_selector_shows_fork_header() -> None:
    init_theme()
    component = UserMessageSelectorComponent(
        [{"id": "entry-1", "text": "hello"}],
        on_select=lambda _entry_id: None,
        on_cancel=lambda: None,
    )
    rendered = "\n".join(strip_ansi(line) for line in component.render(80))
    assert "Fork from Message" in rendered
    assert "hello" in rendered


def test_extension_input_keeps_lines_within_width() -> None:
    init_theme()
    component = ExtensionInputComponent(
        "Extension prompt",
        on_submit=lambda _value: None,
        on_cancel=lambda: None,
    )

    for line in component.render(50):
        assert visible_width(line) <= 50


def test_extension_input_submits_on_enter() -> None:
    init_theme()
    submitted: list[str] = []
    component = ExtensionInputComponent(
        "Title",
        on_submit=submitted.append,
        on_cancel=lambda: None,
    )

    component.handle_input("h")
    component.handle_input("i")
    component.handle_input("\n")
    assert submitted == ["hi"]


def test_extension_input_does_not_prefill_placeholder() -> None:
    init_theme()
    submitted: list[str] = []
    component = ExtensionInputComponent(
        "Title",
        on_submit=submitted.append,
        on_cancel=lambda: None,
        placeholder="example value",
    )
    component.handle_input("\n")
    assert submitted == [""]
