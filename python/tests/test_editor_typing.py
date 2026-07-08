"""Regression: Editor must accept printable input."""

from __future__ import annotations

from pi_mono.tui.components.editor import Editor, EditorOptions


class _FakeTheme:
    border_color = staticmethod(lambda text: text)


class _FakeTui:
    class terminal:
        rows = 24

    def request_render(self) -> None:
        return None


def test_editor_accepts_printable_input() -> None:
    editor = Editor(_FakeTui(), _FakeTheme(), EditorOptions())
    editor.focused = True
    for char in "hello":
        editor.handle_input(char)
    assert editor.get_text() == "hello"


def test_editor_arrow_up_navigates_prompt_history(tmp_path) -> None:
    from pi_mono.coding_agent.core.keybindings import CodingAgentKeybindingsManager
    from pi_mono.tui.keybindings import set_keybindings

    set_keybindings(CodingAgentKeybindingsManager.create(str(tmp_path / "agent")))
    editor = Editor(_FakeTui(), _FakeTheme(), EditorOptions())
    editor.focused = True
    editor.add_to_history("first prompt")
    editor.add_to_history("second prompt")
    editor.handle_input("\x1b[A")
    assert editor.get_text() == "second prompt"
    editor.handle_input("\x1b[A")
    assert editor.get_text() == "first prompt"
    editor.handle_input("\x1b[B")
    assert editor.get_text() == "second prompt"
    editor.handle_input("\x1b[B")
    assert editor.get_text() == ""
