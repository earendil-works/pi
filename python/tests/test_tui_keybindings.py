from pi_mono.tui.keybindings import KeybindingsManager, TUI_KEYBINDINGS


def test_keybindings_no_evict_selector_confirm():
    keybindings = KeybindingsManager(
        TUI_KEYBINDINGS,
        {"tui.input.submit": ["enter", "ctrl+enter"]},
    )
    assert keybindings.get_keys("tui.input.submit") == ["enter", "ctrl+enter"]
    assert keybindings.get_keys("tui.select.confirm") == ["enter"]


def test_keybindings_no_evict_cursor_bindings():
    keybindings = KeybindingsManager(
        TUI_KEYBINDINGS,
        {"tui.select.up": ["up", "ctrl+p"]},
    )
    assert keybindings.get_keys("tui.select.up") == ["up", "ctrl+p"]
    assert keybindings.get_keys("tui.editor.cursorUp") == ["up"]


def test_keybindings_conflict_reporting():
    keybindings = KeybindingsManager(
        TUI_KEYBINDINGS,
        {
            "tui.input.submit": "ctrl+x",
            "tui.select.confirm": "ctrl+x",
        },
    )

    conflicts = keybindings.get_conflicts()
    assert len(conflicts) == 1
    assert conflicts[0].key == "ctrl+x"
    assert conflicts[0].keybindings == ["tui.input.submit", "tui.select.confirm"]
    assert keybindings.get_keys("tui.editor.cursorLeft") == ["left", "ctrl+b"]
