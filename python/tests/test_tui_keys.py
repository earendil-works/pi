from pi_mono.tui.keys import (
    decode_kitty_printable,
    decode_printable_key,
    Key,
    matches_key,
    parse_key,
    set_kitty_protocol_active,
)


def test_matches_key_kitty_alternate_keys():
    # Cyrillic 'с' = codepoint 1089, Latin 'c' = codepoint 99
    # Format: CSI 1089::99;5u (codepoint::base;modifier with ctrl=4, +1=5)
    set_kitty_protocol_active(True)
    cyrillic_ctrl_c = "\x1b[1089::99;5u"
    assert matches_key(cyrillic_ctrl_c, "ctrl+c") is True

    # Cyrillic 'в' = codepoint 1074, Latin 'd' = codepoint 100
    cyrillic_ctrl_d = "\x1b[1074::100;5u"
    assert matches_key(cyrillic_ctrl_d, "ctrl+d") is True

    # Cyrillic 'я' = codepoint 1103, Latin 'z' = codepoint 122
    cyrillic_ctrl_z = "\x1b[1103::122;5u"
    assert matches_key(cyrillic_ctrl_z, "ctrl+z") is True

    # Cyrillic 'з' = codepoint 1079, Latin 'p' = codepoint 112
    cyrillic_ctrl_shift_p = "\x1b[1079::112;6u"
    assert matches_key(cyrillic_ctrl_shift_p, "ctrl+shift+p") is True

    # Direct codepoint when no base layout key
    latin_ctrl_c = "\x1b[99;5u"
    assert matches_key(latin_ctrl_c, "ctrl+c") is True
    set_kitty_protocol_active(False)


def test_matches_key_super_modifiers():
    set_kitty_protocol_active(True)
    assert matches_key("\x1b[107;9u", "super+k") is True
    assert matches_key("\x1b[13;9u", "super+enter") is True
    assert matches_key("\x1b[107;13u", Key.ctrlSuper("k")) is True
    assert matches_key("\x1b[107;13u", "ctrl+super+k") is True
    assert matches_key("\x1b[107;14u", "ctrl+shift+super+k") is True
    assert matches_key("\x1b[107;13u", "super+k") is False
    assert parse_key("\x1b[107;9u") == "super+k"
    assert parse_key("\x1b[13;9u") == "super+enter"
    assert parse_key("\x1b[107;13u") == "ctrl+super+k"
    assert parse_key("\x1b[107;14u") == "shift+ctrl+super+k"
    set_kitty_protocol_active(False)


def test_matches_key_digits_kitty():
    set_kitty_protocol_active(True)
    assert matches_key("\x1b[49u", "1") is True
    assert matches_key("\x1b[49;5u", "ctrl+1") is True
    assert matches_key("\x1b[49;5u", "ctrl+2") is False
    assert parse_key("\x1b[49u") == "1"
    assert parse_key("\x1b[49;5u") == "ctrl+1"
    set_kitty_protocol_active(False)


def test_matches_key_keypad_normalization():
    set_kitty_protocol_active(True)
    assert matches_key("\x1b[57400u", "1") is True
    assert matches_key("\x1b[57410u", "/") is True
    assert matches_key("\x1b[57417u", "left") is True
    assert matches_key("\x1b[57426u", "delete") is True
    assert parse_key("\x1b[57399u") == "0"
    assert parse_key("\x1b[57409u") == "."
    assert parse_key("\x1b[57413u") == "+"
    assert parse_key("\x1b[57416u") == ","
    assert parse_key("\x1b[57417u") == "left"
    assert parse_key("\x1b[57418u") == "right"
    assert parse_key("\x1b[57419u") == "up"
    assert parse_key("\x1b[57420u") == "down"
    assert parse_key("\x1b[57421u") == "pageUp"
    assert parse_key("\x1b[57422u") == "pageDown"
    assert parse_key("\x1b[57423u") == "home"
    assert parse_key("\x1b[57424u") == "end"
    assert parse_key("\x1b[57425u") == "insert"
    assert parse_key("\x1b[57426u") == "delete"
    set_kitty_protocol_active(False)


def test_matches_key_shifted_and_event_types():
    set_kitty_protocol_active(True)
    shifted_key = "\x1b[99:67:99;2u"
    assert matches_key(shifted_key, "shift+c") is True

    release_event = "\x1b[1089::99;5:3u"
    assert matches_key(release_event, "ctrl+c") is True

    full_format = "\x1b[1089:1057:99;6:2u"
    assert matches_key(full_format, "ctrl+shift+c") is True
    set_kitty_protocol_active(False)


def test_matches_key_dvorak_preference():
    set_kitty_protocol_active(True)
    dvorak_ctrl_k = "\x1b[107::118;5u"
    assert matches_key(dvorak_ctrl_k, "ctrl+k") is True
    assert matches_key(dvorak_ctrl_k, "ctrl+v") is False

    dvorak_ctrl_slash = "\x1b[47::91;5u"
    assert matches_key(dvorak_ctrl_slash, "ctrl+/") is True
    assert matches_key(dvorak_ctrl_slash, "ctrl+[") is False
    set_kitty_protocol_active(False)


def test_modify_other_keys_matching():
    set_kitty_protocol_active(False)
    assert matches_key("\x1b[27;5;99~", "ctrl+c") is True
    assert parse_key("\x1b[27;5;99~") == "ctrl+c"

    assert matches_key("\x1b[27;5;100~", "ctrl+d") is True
    assert parse_key("\x1b[27;5;100~") == "ctrl+d"

    assert matches_key("\x1b[27;5;122~", "ctrl+z") is True
    assert parse_key("\x1b[27;5;122~") == "ctrl+z"

    # Enter
    assert matches_key("\x1b[27;5;13~", "ctrl+enter") is True
    assert matches_key("\x1b[27;2;13~", "shift+enter") is True
    assert matches_key("\x1b[27;3;13~", "alt+enter") is True
    assert parse_key("\x1b[27;5;13~") == "ctrl+enter"
    assert parse_key("\x1b[27;2;13~") == "shift+enter"
    assert parse_key("\x1b[27;3;13~") == "alt+enter"

    # Tab
    assert matches_key("\x1b[27;2;9~", "shift+tab") is True
    assert matches_key("\x1b[27;5;9~", "ctrl+tab") is True
    assert matches_key("\x1b[27;3;9~", "alt+tab") is True
    assert parse_key("\x1b[27;2;9~") == "shift+tab"
    assert parse_key("\x1b[27;5;9~") == "ctrl+tab"
    assert parse_key("\x1b[27;3;9~") == "alt+tab"

    # Backspace
    assert matches_key("\x1b[27;1;127~", "backspace") is True
    assert matches_key("\x1b[27;5;127~", "ctrl+backspace") is True
    assert matches_key("\x1b[27;3;127~", "alt+backspace") is True
    assert parse_key("\x1b[27;1;127~") == "backspace"
    assert parse_key("\x1b[27;5;127~") == "ctrl+backspace"
    assert parse_key("\x1b[27;3;127~") == "alt+backspace"

    # Escape
    assert matches_key("\x1b[27;1;27~", "escape") is True
    assert parse_key("\x1b[27;1;27~") == "escape"

    # Space
    assert matches_key("\x1b[27;1;32~", "space") is True
    assert matches_key("\x1b[27;5;32~", "ctrl+space") is True
    assert parse_key("\x1b[27;1;32~") == "space"
    assert parse_key("\x1b[27;5;32~") == "ctrl+space"

    # Combo
    assert matches_key("\x1b[27;5;47~", "ctrl+/") is True
    assert parse_key("\x1b[27;5;47~") == "ctrl+/"

    assert matches_key("\x1b[27;5;49~", "ctrl+1") is True
    assert matches_key("\x1b[27;2;49~", "shift+1") is True
    assert parse_key("\x1b[27;5;49~") == "ctrl+1"
    assert parse_key("\x1b[27;2;49~") == "shift+1"

    # Shifted letters
    assert matches_key("\x1b[27;2;69~", "shift+e") is True
    assert matches_key("\x1b[27;6;69~", "ctrl+shift+e") is True
    assert parse_key("\x1b[27;2;69~") == "shift+e"
    assert parse_key("\x1b[27;6;69~") == "shift+ctrl+e"

    # Ctrl+Alt
    assert matches_key("\x1b[104;7u", "ctrl+alt+h") is True
    assert parse_key("\x1b[104;7u") == "ctrl+alt+h"
    assert matches_key("\x1b[27;7;104~", "ctrl+alt+h") is True
    assert parse_key("\x1b[27;7;104~") == "ctrl+alt+h"


def test_legacy_key_matching():
    set_kitty_protocol_active(False)
    assert matches_key("\x03", "ctrl+c") is True
    assert matches_key("\x04", "ctrl+d") is True
    assert matches_key("\x1b", "escape") is True
    assert matches_key("\n", "enter") is True
    assert parse_key("\n") == "enter"

    # With kitty active
    set_kitty_protocol_active(True)
    assert matches_key("\n", "shift+enter") is True
    assert matches_key("\n", "enter") is False
    assert parse_key("\n") == "shift+enter"
    set_kitty_protocol_active(False)

    assert matches_key("\x00", "ctrl+space") is True
    assert parse_key("\x00") == "ctrl+space"

    assert matches_key("\x1c", "ctrl+\\") is True
    assert parse_key("\x1c") == "ctrl+\\"
    assert matches_key("\x1d", "ctrl+]") is True
    assert parse_key("\x1d") == "ctrl+]"
    assert matches_key("\x1f", "ctrl+_") is True
    assert matches_key("\x1f", "ctrl+-") is True
    assert parse_key("\x1f") == "ctrl+-"


def test_legacy_ctrl_alt_symbols():
    set_kitty_protocol_active(False)
    assert matches_key("\x1b\x1b", "ctrl+alt+[") is True
    assert parse_key("\x1b\x1b") == "ctrl+alt+["
    assert matches_key("\x1b\x1c", "ctrl+alt+\\") is True
    assert parse_key("\x1b\x1c") == "ctrl+alt+\\"
    assert matches_key("\x1b\x1d", "ctrl+alt+]") is True
    assert parse_key("\x1b\x1d") == "ctrl+alt+]"
    assert matches_key("\x1b\x1f", "ctrl+alt+_") is True
    assert matches_key("\x1b\x1f", "ctrl+alt+-") is True
    assert parse_key("\x1b\x1f") == "ctrl+alt+-"


def test_backspace_wt_env(monkeypatch):
    set_kitty_protocol_active(False)

    # Outside Windows Terminal
    monkeypatch.delenv("WT_SESSION", raising=False)
    assert matches_key("\x7f", "backspace") is True
    assert matches_key("\x7f", "ctrl+backspace") is False
    assert parse_key("\x7f") == "backspace"
    assert matches_key("\x08", "backspace") is True
    assert matches_key("\x08", "ctrl+backspace") is False
    assert parse_key("\x08") == "backspace"
    assert matches_key("\x08", "ctrl+h") is True

    # Inside Windows Terminal (local)
    monkeypatch.setenv("WT_SESSION", "test-session")
    monkeypatch.delenv("SSH_CONNECTION", raising=False)
    monkeypatch.delenv("SSH_CLIENT", raising=False)
    monkeypatch.delenv("SSH_TTY", raising=False)
    assert matches_key("\x08", "ctrl+backspace") is True
    assert matches_key("\x08", "backspace") is False
    assert parse_key("\x08") == "ctrl+backspace"
    assert matches_key("\x08", "ctrl+h") is True

    # Inside Windows Terminal (SSH)
    monkeypatch.setenv("WT_SESSION", "test-session")
    monkeypatch.setenv("SSH_CONNECTION", "1 2 3 4")
    monkeypatch.setenv("SSH_CLIENT", "1 2 3")
    monkeypatch.setenv("SSH_TTY", "/dev/pts/1")
    assert matches_key("\x08", "ctrl+backspace") is False
    assert matches_key("\x08", "backspace") is True
    assert parse_key("\x08") == "backspace"
    assert matches_key("\x08", "ctrl+h") is True


def test_legacy_alt_prefixed():
    set_kitty_protocol_active(False)
    assert matches_key("\x1b ", "alt+space") is True
    assert parse_key("\x1b ") == "alt+space"
    assert matches_key("\x1b\b", "alt+backspace") is True
    assert parse_key("\x1b\b") == "alt+backspace"
    assert matches_key("\x1b\x03", "ctrl+alt+c") is True
    assert parse_key("\x1b\x03") == "ctrl+alt+c"
    assert matches_key("\x1bB", "alt+left") is True
    assert parse_key("\x1bB") == "alt+left"
    assert matches_key("\x1bF", "alt+right") is True
    assert parse_key("\x1bF") == "alt+right"
    assert matches_key("\x1ba", "alt+a") is True
    assert parse_key("\x1ba") == "alt+a"
    assert matches_key("\x1b1", "alt+1") is True
    assert parse_key("\x1b1") == "alt+1"
    assert matches_key("\x1by", "alt+y") is True
    assert parse_key("\x1by") == "alt+y"

    set_kitty_protocol_active(True)
    assert matches_key("\x1b ", "alt+space") is False
    assert parse_key("\x1b ") is None
    assert matches_key("\x1b\b", "alt+backspace") is True
    assert parse_key("\x1b\b") == "alt+backspace"
    assert matches_key("\x1b\x03", "ctrl+alt+c") is False
    assert parse_key("\x1b\x03") is None
    assert matches_key("\x1bB", "alt+left") is False
    assert parse_key("\x1bB") is None
    assert matches_key("\x1bF", "alt+right") is False
    assert parse_key("\x1bF") is None
    assert matches_key("\x1ba", "alt+a") is False
    assert parse_key("\x1ba") is None
    assert matches_key("\x1b1", "alt+1") is False
    assert parse_key("\x1b1") is None
    assert matches_key("\x1by", "alt+y") is False
    assert parse_key("\x1by") is None
    set_kitty_protocol_active(False)


def test_legacy_arrows_and_functional():
    assert matches_key("\x1b[A", "up") is True
    assert matches_key("\x1b[B", "down") is True
    assert matches_key("\x1b[C", "right") is True
    assert matches_key("\x1b[D", "left") is True

    # SS3
    assert matches_key("\x1bOA", "up") is True
    assert matches_key("\x1bOB", "down") is True
    assert matches_key("\x1bOC", "right") is True
    assert matches_key("\x1bOD", "left") is True
    assert matches_key("\x1bOH", "home") is True
    assert matches_key("\x1bOF", "end") is True

    # Function keys and Clear
    assert matches_key("\x1bOP", "f1") is True
    assert matches_key("\x1b[24~", "f12") is True
    assert matches_key("\x1b[E", "clear") is True

    # Alt+arrow
    assert matches_key("\x1bp", "alt+up") is True
    assert matches_key("\x1bp", "up") is False

    # rxvt modifier sequences
    assert matches_key("\x1b[a", "shift+up") is True
    assert matches_key("\x1bOa", "ctrl+up") is True
    assert matches_key("\x1b[2$", "shift+insert") is True
    assert matches_key("\x1b[2^", "ctrl+insert") is True
    assert matches_key("\x1b[7$", "shift+home") is True


def test_decode_kitty_printable():
    assert decode_kitty_printable("\x1b[57399u") == "0"
    assert decode_kitty_printable("\x1b[57400u") == "1"
    assert decode_kitty_printable("\x1b[57409u") == "."
    assert decode_kitty_printable("\x1b[57410u") == "/"
    assert decode_kitty_printable("\x1b[57411u") == "*"
    assert decode_kitty_printable("\x1b[57412u") == "-"
    assert decode_kitty_printable("\x1b[57413u") == "+"
    assert decode_kitty_printable("\x1b[57415u") == "="
    assert decode_kitty_printable("\x1b[57416u") == ","
    assert decode_kitty_printable("\x1b[57417u") is None


def test_decode_printable_key():
    assert decode_printable_key("\x1b[27;2;69~") == "E"
    assert decode_printable_key("\x1b[27;2;196~") == "Ä"
    assert decode_printable_key("\x1b[27;2;32~") == " "
    assert decode_printable_key("\x1b[27;2;13~") is None
    assert decode_printable_key("\x1b[27;6;69~") is None


def test_parse_key_unsupported_kitty_modifiers():
    set_kitty_protocol_active(True)
    assert parse_key("\x1b[99;17u") is None
    set_kitty_protocol_active(False)
