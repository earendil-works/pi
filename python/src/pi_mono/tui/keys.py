import re
from typing import Any, Literal

# =============================================================================
# Global Kitty Protocol State
# =============================================================================

_kitty_protocol_active = False


def set_kitty_protocol_active(active: bool) -> None:
    global _kitty_protocol_active
    _kitty_protocol_active = active


def is_kitty_protocol_active() -> bool:
    return _kitty_protocol_active


# =============================================================================
# Key Helper definitions
# =============================================================================


class Key:
    # Special keys
    escape = "escape"
    esc = "esc"
    enter = "enter"
    space = "space"
    tab = "tab"
    backspace = "backspace"
    delete = "delete"
    insert = "insert"
    clear = "clear"
    home = "home"
    end = "end"
    pageUp = "pageUp"
    pageDown = "pageDown"
    up = "up"
    down = "down"
    left = "left"
    right = "right"
    f1 = "f1"
    f2 = "f2"
    f3 = "f3"
    f4 = "f4"
    f5 = "f5"
    f6 = "f6"
    f7 = "f7"
    f8 = "f8"
    f9 = "f9"
    f10 = "f10"
    f11 = "f11"
    f12 = "f12"

    # Symbol keys
    backtick = "`"
    hyphen = "-"
    equals = "="
    leftbracket = "["
    rightbracket = "]"
    backslash = "\\"
    semicolon = ";"
    quote = "'"
    comma = ","
    period = "."
    slash = "/"
    exclamation = "!"
    at = "@"
    hash = "#"
    dollar = "$"
    percent = "%"
    caret = "^"
    ampersand = "&"
    asterisk = "*"
    leftparen = "("
    rightparen = ")"
    underscore = "_"
    plus = "+"
    pipe = "|"
    tilde = "~"
    leftbrace = "{"
    rightbrace = "}"
    colon = ":"
    lessthan = "<"
    greaterthan = ">"
    question = "?"

    # Single modifiers
    @staticmethod
    def ctrl(key: str) -> str:
        return f"ctrl+{key}"

    @staticmethod
    def shift(key: str) -> str:
        return f"shift+{key}"

    @staticmethod
    def alt(key: str) -> str:
        return f"alt+{key}"

    @staticmethod
    def super(key: str) -> str:
        return f"super+{key}"

    # Combined modifiers
    @staticmethod
    def ctrlShift(key: str) -> str:
        return f"ctrl+shift+{key}"

    @staticmethod
    def shiftCtrl(key: str) -> str:
        return f"shift+ctrl+{key}"

    @staticmethod
    def ctrlAlt(key: str) -> str:
        return f"ctrl+alt+{key}"

    @staticmethod
    def altCtrl(key: str) -> str:
        return f"alt+ctrl+{key}"

    @staticmethod
    def shiftAlt(key: str) -> str:
        return f"shift+alt+{key}"

    @staticmethod
    def altShift(key: str) -> str:
        return f"alt+shift+{key}"

    @staticmethod
    def ctrlSuper(key: str) -> str:
        return f"ctrl+super+{key}"

    @staticmethod
    def superCtrl(key: str) -> str:
        return f"super+ctrl+{key}"

    @staticmethod
    def shiftSuper(key: str) -> str:
        return f"shift+super+{key}"

    @staticmethod
    def superShift(key: str) -> str:
        return f"super+shift+{key}"

    @staticmethod
    def altSuper(key: str) -> str:
        return f"alt+super+{key}"

    @staticmethod
    def superAlt(key: str) -> str:
        return f"super+alt+{key}"

    # Triple modifiers
    @staticmethod
    def ctrlShiftAlt(key: str) -> str:
        return f"ctrl+shift+alt+{key}"

    @staticmethod
    def ctrlShiftSuper(key: str) -> str:
        return f"ctrl+shift+super+{key}"


SYMBOL_KEYS = {
    "`",
    "-",
    "=",
    "[",
    "]",
    "\\",
    ";",
    "'",
    ",",
    ".",
    "/",
    "!",
    "@",
    "#",
    "$",
    "%",
    "^",
    "&",
    "*",
    "(",
    ")",
    "_",
    "+",
    "|",
    "~",
    "{",
    "}",
    ":",
    "<",
    ">",
    "?",
}

MODIFIERS = {
    "shift": 1,
    "alt": 2,
    "ctrl": 4,
    "super": 8,
}

LOCK_MASK = 64 + 128  # Caps Lock + Num Lock

CODEPOINTS = {
    "escape": 27,
    "tab": 9,
    "enter": 13,
    "space": 32,
    "backspace": 127,
    "kpEnter": 57414,
}

ARROW_CODEPOINTS = {
    "up": -1,
    "down": -2,
    "right": -3,
    "left": -4,
}

FUNCTIONAL_CODEPOINTS = {
    "delete": -10,
    "insert": -11,
    "pageUp": -12,
    "pageDown": -13,
    "home": -14,
    "end": -15,
}

KITTY_FUNCTIONAL_KEY_EQUIVALENTS = {
    57399: 48,  # KP_0 -> 0
    57400: 49,  # KP_1 -> 1
    57401: 50,  # KP_2 -> 2
    57402: 51,  # KP_3 -> 3
    57403: 52,  # KP_4 -> 4
    57404: 53,  # KP_5 -> 5
    57405: 54,  # KP_6 -> 6
    57406: 55,  # KP_7 -> 7
    57407: 56,  # KP_8 -> 8
    57408: 57,  # KP_9 -> 9
    57409: 46,  # KP_DECIMAL -> .
    57410: 47,  # KP_DIVIDE -> /
    57411: 42,  # KP_MULTIPLY -> *
    57412: 45,  # KP_SUBTRACT -> -
    57413: 43,  # KP_ADD -> +
    57415: 61,  # KP_EQUAL -> =
    57416: 44,  # KP_SEPARATOR -> ,
    57417: ARROW_CODEPOINTS["left"],
    57418: ARROW_CODEPOINTS["right"],
    57419: ARROW_CODEPOINTS["up"],
    57420: ARROW_CODEPOINTS["down"],
    57421: FUNCTIONAL_CODEPOINTS["pageUp"],
    57422: FUNCTIONAL_CODEPOINTS["pageDown"],
    57423: FUNCTIONAL_CODEPOINTS["home"],
    57424: FUNCTIONAL_CODEPOINTS["end"],
    57425: FUNCTIONAL_CODEPOINTS["insert"],
    57426: FUNCTIONAL_CODEPOINTS["delete"],
}


def normalize_kitty_functional_codepoint(codepoint: int) -> int:
    return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint, codepoint)


def normalize_shifted_letter_identity_codepoint(codepoint: int, modifier: int) -> int:
    effective_modifier = modifier & ~LOCK_MASK
    if (effective_modifier & MODIFIERS["shift"]) != 0 and 65 <= codepoint <= 90:
        return codepoint + 32
    return codepoint


LEGACY_KEY_SEQUENCES = {
    "up": ("\x1b[A", "\x1bOA"),
    "down": ("\x1b[B", "\x1bOB"),
    "right": ("\x1b[C", "\x1bOC"),
    "left": ("\x1b[D", "\x1bOD"),
    "home": ("\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"),
    "end": ("\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"),
    "insert": ("\x1b[2~",),
    "delete": ("\x1b[3~",),
    "pageUp": ("\x1b[5~", "\x1b[[5~"),
    "pageDown": ("\x1b[6~", "\x1b[[6~"),
    "clear": ("\x1b[E", "\x1bOE"),
    "f1": ("\x1bOP", "\x1b[11~", "\x1b[[A"),
    "f2": ("\x1bOQ", "\x1b[12~", "\x1b[[B"),
    "f3": ("\x1bOR", "\x1b[13~", "\x1b[[C"),
    "f4": ("\x1bOS", "\x1b[14~", "\x1b[[D"),
    "f5": ("\x1b[15~", "\x1b[[E"),
    "f6": ("\x1b[17~",),
    "f7": ("\x1b[18~",),
    "f8": ("\x1b[19~",),
    "f9": ("\x1b[20~",),
    "f10": ("\x1b[21~",),
    "f11": ("\x1b[23~",),
    "f12": ("\x1b[24~",),
}

LEGACY_SHIFT_SEQUENCES = {
    "up": ("\x1b[a",),
    "down": ("\x1b[b",),
    "right": ("\x1b[c",),
    "left": ("\x1b[d",),
    "clear": ("\x1b[e",),
    "insert": ("\x1b[2$",),
    "delete": ("\x1b[3$",),
    "pageUp": ("\x1b[5$",),
    "pageDown": ("\x1b[6$",),
    "home": ("\x1b[7$",),
    "end": ("\x1b[8$",),
}

LEGACY_CTRL_SEQUENCES = {
    "up": ("\x1bOa",),
    "down": ("\x1bOb",),
    "right": ("\x1bOc",),
    "left": ("\x1bOd",),
    "clear": ("\x1bOe",),
    "insert": ("\x1b[2^",),
    "delete": ("\x1b[3^",),
    "pageUp": ("\x1b[5^",),
    "pageDown": ("\x1b[6^",),
    "home": ("\x1b[7^",),
    "end": ("\x1b[8^",),
}

LEGACY_SEQUENCE_KEY_IDS = {
    "\x1bOA": "up",
    "\x1bOB": "down",
    "\x1bOC": "right",
    "\x1bOD": "left",
    "\x1bOH": "home",
    "\x1bOF": "end",
    "\x1b[E": "clear",
    "\x1bOE": "clear",
    "\x1bOe": "ctrl+clear",
    "\x1b[e": "shift+clear",
    "\x1b[2~": "insert",
    "\x1b[2$": "shift+insert",
    "\x1b[2^": "ctrl+insert",
    "\x1b[3$": "shift+delete",
    "\x1b[3^": "ctrl+delete",
    "\x1b[[5~": "pageUp",
    "\x1b[[6~": "pageDown",
    "\x1b[a": "shift+up",
    "\x1b[b": "shift+down",
    "\x1b[c": "shift+right",
    "\x1b[d": "shift+left",
    "\x1bOa": "ctrl+up",
    "\x1bOb": "ctrl+down",
    "\x1bOc": "ctrl+right",
    "\x1bOd": "ctrl+left",
    "\x1b[5$": "shift+pageUp",
    "\x1b[6$": "shift+pageDown",
    "\x1b[7$": "shift+home",
    "\x1b[8$": "shift+end",
    "\x1b[5^": "ctrl+pageUp",
    "\x1b[6^": "ctrl+pageDown",
    "\x1b[7^": "ctrl+home",
    "\x1b[8^": "ctrl+end",
    "\x1bOP": "f1",
    "\x1bOQ": "f2",
    "\x1bOR": "f3",
    "\x1bOS": "f4",
    "\x1b[11~": "f1",
    "\x1b[12~": "f2",
    "\x1b[13~": "f3",
    "\x1b[14~": "f4",
    "\x1b[[A": "f1",
    "\x1b[[B": "f2",
    "\x1b[[C": "f3",
    "\x1b[[D": "f4",
    "\x1b[[E": "f5",
    "\x1b[15~": "f5",
    "\x1b[17~": "f6",
    "\x1b[18~": "f7",
    "\x1b[19~": "f8",
    "\x1b[20~": "f9",
    "\x1b[21~": "f10",
    "\x1b[23~": "f11",
    "\x1b[24~": "f12",
    "\x1bb": "alt+left",
    "\x1bf": "alt+right",
    "\x1bp": "alt+up",
    "\x1bn": "alt+down",
}


def matches_legacy_sequence(data: str, sequences: tuple[str, ...]) -> bool:
    return data in sequences


def matches_legacy_modifier_sequence(data: str, key: str, modifier: int) -> bool:
    if modifier == MODIFIERS["shift"]:
        return matches_legacy_sequence(data, LEGACY_SHIFT_SEQUENCES.get(key, ()))
    if modifier == MODIFIERS["ctrl"]:
        return matches_legacy_sequence(data, LEGACY_CTRL_SEQUENCES.get(key, ()))
    return False


# =============================================================================
# Kitty Protocol Parsing
# =============================================================================

KeyEventType = Literal["press", "repeat", "release"]


class ParsedKittySequence:
    def __init__(
        self,
        codepoint: int,
        modifier: int,
        eventType: KeyEventType,
        shiftedKey: int | None = None,
        baseLayoutKey: int | None = None,
    ):
        self.codepoint = codepoint
        self.shiftedKey = shiftedKey
        self.baseLayoutKey = baseLayoutKey
        self.modifier = modifier
        self.eventType = eventType


class ParsedModifyOtherKeysSequence:
    def __init__(self, codepoint: int, modifier: int):
        self.codepoint = codepoint
        self.modifier = modifier


_last_event_type: KeyEventType = "press"


def is_key_release(data: str) -> bool:
    if "\x1b[200~" in data:
        return False

    if any(suffix in data for suffix in (":3u", ":3~", ":3A", ":3B", ":3C", ":3D", ":3H", ":3F")):
        return True
    return False


def is_key_repeat(data: str) -> bool:
    if "\x1b[200~" in data:
        return False

    if any(suffix in data for suffix in (":2u", ":2~", ":2A", ":2B", ":2C", ":2D", ":2H", ":2F")):
        return True
    return False


def parse_event_type(event_type_str: str | None) -> KeyEventType:
    if not event_type_str:
        return "press"
    try:
        val = int(event_type_str)
        if val == 2:
            return "repeat"
        if val == 3:
            return "release"
    except ValueError:
        pass
    return "press"


def parse_kitty_sequence(data: str) -> ParsedKittySequence | None:
    global _last_event_type
    # CSI u format with alternate keys (flag 4): \x1b[<codepoint>[:<shifted>[:<base>]];<mod>[:<event>]u
    match = re.match(r"^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$", data)
    if match:
        codepoint = int(match.group(1))
        shifted_str = match.group(2)
        shiftedKey = int(shifted_str) if shifted_str and len(shifted_str) > 0 else None
        base_str = match.group(3)
        baseLayoutKey = int(base_str) if base_str else None
        mod_str = match.group(4)
        modValue = int(mod_str) if mod_str else 1
        eventType = parse_event_type(match.group(5))
        _last_event_type = eventType
        return ParsedKittySequence(codepoint, modValue - 1, eventType, shiftedKey, baseLayoutKey)

    # Arrow keys with modifier: \x1b[1;<mod>A/B/C/D or \x1b[1;<mod>:<event>A/B/C/D
    match = re.match(r"^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$", data)
    if match:
        modValue = int(match.group(1))
        eventType = parse_event_type(match.group(2))
        arrow_codes = {"A": -1, "B": -2, "C": -3, "D": -4}
        codepoint = arrow_codes[match.group(3)]
        _last_event_type = eventType
        return ParsedKittySequence(codepoint, modValue - 1, eventType)

    # Functional keys: \x1b[<num>~ or \x1b[<num>;<mod>~ or \x1b[<num>;<mod>:<event>~
    match = re.match(r"^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$", data)
    if match:
        key_num = int(match.group(1))
        mod_str = match.group(2)
        modValue = int(mod_str) if mod_str else 1
        eventType = parse_event_type(match.group(3))
        func_codes = {
            2: FUNCTIONAL_CODEPOINTS["insert"],
            3: FUNCTIONAL_CODEPOINTS["delete"],
            5: FUNCTIONAL_CODEPOINTS["pageUp"],
            6: FUNCTIONAL_CODEPOINTS["pageDown"],
            7: FUNCTIONAL_CODEPOINTS["home"],
        }
        fn_codepoint = func_codes.get(key_num)
        if fn_codepoint is not None:
            _last_event_type = eventType
            return ParsedKittySequence(fn_codepoint, modValue - 1, eventType)
    # Home/End with modifier: \x1b[1;<mod>H/F or \x1b[1;<mod>:<event>H/F
    match = re.match(r"^\x1b\[1;(\d+)(?::(\d+))?([HF])$", data)
    if match:
        modValue = int(match.group(1))
        eventType = parse_event_type(match.group(2))
        codepoint = (
            FUNCTIONAL_CODEPOINTS["home"] if match.group(3) == "H" else FUNCTIONAL_CODEPOINTS["end"]
        )
        _last_event_type = eventType
        return ParsedKittySequence(codepoint, modValue - 1, eventType)

    return None


def matches_kitty_sequence(data: str, expectedCodepoint: int, expectedModifier: int) -> bool:
    parsed = parse_kitty_sequence(data)
    if not parsed:
        return False
    actual_mod = parsed.modifier & ~LOCK_MASK
    expected_mod = expectedModifier & ~LOCK_MASK

    if actual_mod != expected_mod:
        return False

    normalized_codepoint = normalize_shifted_letter_identity_codepoint(
        normalize_kitty_functional_codepoint(parsed.codepoint), parsed.modifier
    )
    normalized_expected_codepoint = normalize_shifted_letter_identity_codepoint(
        normalize_kitty_functional_codepoint(expectedCodepoint), expectedModifier
    )

    if normalized_codepoint == normalized_expected_codepoint:
        return True

    if parsed.baseLayoutKey is not None and parsed.baseLayoutKey == expectedCodepoint:
        cp = normalized_codepoint
        is_latin_letter = 97 <= cp <= 122
        try:
            is_known_symbol = chr(cp) in SYMBOL_KEYS
        except ValueError:
            is_known_symbol = False
        if not is_latin_letter and not is_known_symbol:
            return True

    return False


def parse_modify_other_keys_sequence(data: str) -> ParsedModifyOtherKeysSequence | None:
    match = re.match(r"^\x1b\[27;(\d+);(\d+)~$", data)
    if not match:
        return None
    mod_value = int(match.group(1))
    codepoint = int(match.group(2))
    return ParsedModifyOtherKeysSequence(codepoint, mod_value - 1)


def matches_modify_other_keys(data: str, expectedKeycode: int, expectedModifier: int) -> bool:
    parsed = parse_modify_other_keys_sequence(data)
    if not parsed:
        return False
    return parsed.codepoint == expectedKeycode and parsed.modifier == expectedModifier


def is_windows_terminal_session() -> bool:
    import os

    return bool(os.environ.get("WT_SESSION")) and not any(
        os.environ.get(k) for k in ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY")
    )


def matches_raw_backspace(data: str, expected_modifier: int) -> bool:
    if data == "\x7f":
        return expected_modifier == 0
    if data != "\x08":
        return False
    return (
        expected_modifier == MODIFIERS["ctrl"]
        if is_windows_terminal_session()
        else expected_modifier == 0
    )


def raw_ctrl_char(key: str) -> str | None:
    char = key.lower()
    if len(char) == 0:
        return None
    code = ord(char[0])
    if (97 <= code <= 122) or char in ("[", "\\", "]", "_"):
        return chr(code & 0x1F)
    if char == "-":
        return chr(31)  # Same as Ctrl+_
    return None


def is_digit_key(key: str) -> bool:
    return len(key) == 1 and "0" <= key <= "9"


def matches_printable_modify_other_keys(
    data: str, expected_keycode: int, expected_modifier: int
) -> bool:
    if expected_modifier == 0:
        return False
    parsed = parse_modify_other_keys_sequence(data)
    if not parsed or parsed.modifier != expected_modifier:
        return False
    return normalize_shifted_letter_identity_codepoint(
        parsed.codepoint, parsed.modifier
    ) == normalize_shifted_letter_identity_codepoint(expected_keycode, expected_modifier)


def format_key_name_with_modifiers(key_name: str, modifier: int) -> str | None:
    mods = []
    effective_mod = modifier & ~LOCK_MASK
    supported_modifier_mask = (
        MODIFIERS["shift"] | MODIFIERS["ctrl"] | MODIFIERS["alt"] | MODIFIERS["super"]
    )
    if (effective_mod & ~supported_modifier_mask) != 0:
        return None
    if effective_mod & MODIFIERS["shift"]:
        mods.append("shift")
    if effective_mod & MODIFIERS["ctrl"]:
        mods.append("ctrl")
    if effective_mod & MODIFIERS["alt"]:
        mods.append("alt")
    if effective_mod & MODIFIERS["super"]:
        mods.append("super")
    return "+".join(mods) + f"+{key_name}" if mods else key_name


def parse_key_id(key_id: str) -> dict[str, Any] | None:
    parts = key_id.lower().split("+")
    key = parts[-1]
    if not key:
        return None
    return {
        "key": key,
        "ctrl": "ctrl" in parts,
        "shift": "shift" in parts,
        "alt": "alt" in parts,
        "super": "super" in parts,
    }


def matches_key(data: str, key_id: str) -> bool:
    parsed = parse_key_id(key_id)
    if not parsed:
        return False

    key = parsed["key"]
    ctrl = parsed["ctrl"]
    shift = parsed["shift"]
    alt = parsed["alt"]
    super_modifier = parsed["super"]

    modifier = 0
    if shift:
        modifier |= MODIFIERS["shift"]
    if alt:
        modifier |= MODIFIERS["alt"]
    if ctrl:
        modifier |= MODIFIERS["ctrl"]
    if super_modifier:
        modifier |= MODIFIERS["super"]

    if key in ("escape", "esc"):
        if modifier != 0:
            return False
        return (
            data == "\x1b"
            or matches_kitty_sequence(data, CODEPOINTS["escape"], 0)
            or matches_modify_other_keys(data, CODEPOINTS["escape"], 0)
        )

    elif key == "space":
        if not _kitty_protocol_active:
            if modifier == MODIFIERS["ctrl"] and data == "\x00":
                return True
            if modifier == MODIFIERS["alt"] and data == "\x1b ":
                return True
        if modifier == 0:
            return (
                data == " "
                or matches_kitty_sequence(data, CODEPOINTS["space"], 0)
                or matches_modify_other_keys(data, CODEPOINTS["space"], 0)
            )
        return matches_kitty_sequence(
            data, CODEPOINTS["space"], modifier
        ) or matches_modify_other_keys(data, CODEPOINTS["space"], modifier)

    elif key == "tab":
        if modifier == MODIFIERS["shift"]:
            return (
                data == "\x1b[Z"
                or matches_kitty_sequence(data, CODEPOINTS["tab"], MODIFIERS["shift"])
                or matches_modify_other_keys(data, CODEPOINTS["tab"], MODIFIERS["shift"])
            )
        if modifier == 0:
            return data == "\t" or matches_kitty_sequence(data, CODEPOINTS["tab"], 0)
        return matches_kitty_sequence(
            data, CODEPOINTS["tab"], modifier
        ) or matches_modify_other_keys(data, CODEPOINTS["tab"], modifier)

    elif key in ("enter", "return"):
        if modifier == MODIFIERS["shift"]:
            if matches_kitty_sequence(
                data, CODEPOINTS["enter"], MODIFIERS["shift"]
            ) or matches_kitty_sequence(data, CODEPOINTS["kpEnter"], MODIFIERS["shift"]):
                return True
            if matches_modify_other_keys(data, CODEPOINTS["enter"], MODIFIERS["shift"]):
                return True
            if _kitty_protocol_active:
                return data == "\x1b\r" or data == "\n"
            return False
        if modifier == MODIFIERS["alt"]:
            if matches_kitty_sequence(
                data, CODEPOINTS["enter"], MODIFIERS["alt"]
            ) or matches_kitty_sequence(data, CODEPOINTS["kpEnter"], MODIFIERS["alt"]):
                return True
            if matches_modify_other_keys(data, CODEPOINTS["enter"], MODIFIERS["alt"]):
                return True
            if not _kitty_protocol_active:
                return data == "\x1b\r"
            return False
        if modifier == 0:
            return (
                data == "\r"
                or (not _kitty_protocol_active and data == "\n")
                or data == "\x1bOM"
                or matches_kitty_sequence(data, CODEPOINTS["enter"], 0)
                or matches_kitty_sequence(data, CODEPOINTS["kpEnter"], 0)
            )
        return (
            matches_kitty_sequence(data, CODEPOINTS["enter"], modifier)
            or matches_kitty_sequence(data, CODEPOINTS["kpEnter"], modifier)
            or matches_modify_other_keys(data, CODEPOINTS["enter"], modifier)
        )

    elif key == "backspace":
        if modifier == MODIFIERS["alt"]:
            if data == "\x1b\x7f" or data == "\x1b\b":
                return True
            return matches_kitty_sequence(
                data, CODEPOINTS["backspace"], MODIFIERS["alt"]
            ) or matches_modify_other_keys(data, CODEPOINTS["backspace"], MODIFIERS["alt"])
        if modifier == MODIFIERS["ctrl"]:
            if matches_raw_backspace(data, MODIFIERS["ctrl"]):
                return True
            return matches_kitty_sequence(
                data, CODEPOINTS["backspace"], MODIFIERS["ctrl"]
            ) or matches_modify_other_keys(data, CODEPOINTS["backspace"], MODIFIERS["ctrl"])
        if modifier == 0:
            return (
                matches_raw_backspace(data, 0)
                or matches_kitty_sequence(data, CODEPOINTS["backspace"], 0)
                or matches_modify_other_keys(data, CODEPOINTS["backspace"], 0)
            )
        return matches_kitty_sequence(
            data, CODEPOINTS["backspace"], modifier
        ) or matches_modify_other_keys(data, CODEPOINTS["backspace"], modifier)

    elif key == "insert":
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["insert"]
            ) or matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["insert"], 0)
        if matches_legacy_modifier_sequence(data, "insert", modifier):
            return True
        return matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["insert"], modifier)

    elif key == "delete":
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["delete"]
            ) or matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["delete"], 0)
        if matches_legacy_modifier_sequence(data, "delete", modifier):
            return True
        return matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["delete"], modifier)

    elif key == "clear":
        if modifier == 0:
            return matches_legacy_sequence(data, LEGACY_KEY_SEQUENCES["clear"])
        return matches_legacy_modifier_sequence(data, "clear", modifier)

    elif key == "home":
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["home"]
            ) or matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["home"], 0)
        if matches_legacy_modifier_sequence(data, "home", modifier):
            return True
        return matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["home"], modifier)

    elif key == "end":
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["end"]
            ) or matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["end"], 0)
        if matches_legacy_modifier_sequence(data, "end", modifier):
            return True
        return matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["end"], modifier)

    elif key == "pageup":
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["pageUp"]
            ) or matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["pageUp"], 0)
        if matches_legacy_modifier_sequence(data, "pageUp", modifier):
            return True
        return matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["pageUp"], modifier)

    elif key == "pagedown":
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["pageDown"]
            ) or matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["pageDown"], 0)
        if matches_legacy_modifier_sequence(data, "pageDown", modifier):
            return True
        return matches_kitty_sequence(data, FUNCTIONAL_CODEPOINTS["pageDown"], modifier)

    elif key == "up":
        if modifier == MODIFIERS["alt"]:
            return data == "\x1bp" or matches_kitty_sequence(
                data, ARROW_CODEPOINTS["up"], MODIFIERS["alt"]
            )
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["up"]
            ) or matches_kitty_sequence(data, ARROW_CODEPOINTS["up"], 0)
        if matches_legacy_modifier_sequence(data, "up", modifier):
            return True
        return matches_kitty_sequence(data, ARROW_CODEPOINTS["up"], modifier)

    elif key == "down":
        if modifier == MODIFIERS["alt"]:
            return data == "\x1bn" or matches_kitty_sequence(
                data, ARROW_CODEPOINTS["down"], MODIFIERS["alt"]
            )
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["down"]
            ) or matches_kitty_sequence(data, ARROW_CODEPOINTS["down"], 0)
        if matches_legacy_modifier_sequence(data, "down", modifier):
            return True
        return matches_kitty_sequence(data, ARROW_CODEPOINTS["down"], modifier)

    elif key == "left":
        if modifier == MODIFIERS["alt"]:
            return (
                data == "\x1b[1;3D"
                or (not _kitty_protocol_active and data == "\x1bB")
                or data == "\x1bb"
                or matches_kitty_sequence(data, ARROW_CODEPOINTS["left"], MODIFIERS["alt"])
            )
        if modifier == MODIFIERS["ctrl"]:
            return (
                data == "\x1b[1;5D"
                or matches_legacy_modifier_sequence(data, "left", MODIFIERS["ctrl"])
                or matches_kitty_sequence(data, ARROW_CODEPOINTS["left"], MODIFIERS["ctrl"])
            )
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["left"]
            ) or matches_kitty_sequence(data, ARROW_CODEPOINTS["left"], 0)
        if matches_legacy_modifier_sequence(data, "left", modifier):
            return True
        return matches_kitty_sequence(data, ARROW_CODEPOINTS["left"], modifier)

    elif key == "right":
        if modifier == MODIFIERS["alt"]:
            return (
                data == "\x1b[1;3C"
                or (not _kitty_protocol_active and data == "\x1bF")
                or data == "\x1bf"
                or matches_kitty_sequence(data, ARROW_CODEPOINTS["right"], MODIFIERS["alt"])
            )
        if modifier == MODIFIERS["ctrl"]:
            return (
                data == "\x1b[1;5C"
                or matches_legacy_modifier_sequence(data, "right", MODIFIERS["ctrl"])
                or matches_kitty_sequence(data, ARROW_CODEPOINTS["right"], MODIFIERS["ctrl"])
            )
        if modifier == 0:
            return matches_legacy_sequence(
                data, LEGACY_KEY_SEQUENCES["right"]
            ) or matches_kitty_sequence(data, ARROW_CODEPOINTS["right"], 0)
        if matches_legacy_modifier_sequence(data, "right", modifier):
            return True
        return matches_kitty_sequence(data, ARROW_CODEPOINTS["right"], modifier)

    elif key in ("f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"):
        if modifier != 0:
            return False
        return matches_legacy_sequence(data, LEGACY_KEY_SEQUENCES[key])

    # Handle single letter/digit keys and symbols
    if len(key) == 1 and (("a" <= key <= "z") or is_digit_key(key) or key in SYMBOL_KEYS):
        codepoint = ord(key)
        raw_ctrl = raw_ctrl_char(key)
        is_letter = "a" <= key <= "z"
        is_digit = is_digit_key(key)

        if (
            modifier == MODIFIERS["ctrl"] + MODIFIERS["alt"]
            and not _kitty_protocol_active
            and raw_ctrl
        ):
            if data == f"\x1b{raw_ctrl}":
                return True

        if modifier == MODIFIERS["alt"] and not _kitty_protocol_active and (is_letter or is_digit):
            if data == f"\x1b{key}":
                return True

        if modifier == MODIFIERS["ctrl"]:
            if raw_ctrl and data == raw_ctrl:
                return True
            return matches_kitty_sequence(
                data, codepoint, MODIFIERS["ctrl"]
            ) or matches_printable_modify_other_keys(data, codepoint, MODIFIERS["ctrl"])

        if modifier == MODIFIERS["shift"] + MODIFIERS["ctrl"]:
            return matches_kitty_sequence(
                data, codepoint, MODIFIERS["shift"] + MODIFIERS["ctrl"]
            ) or matches_printable_modify_other_keys(
                data, codepoint, MODIFIERS["shift"] + MODIFIERS["ctrl"]
            )

        if modifier == MODIFIERS["shift"]:
            if is_letter and data == key.upper():
                return True
            return matches_kitty_sequence(
                data, codepoint, MODIFIERS["shift"]
            ) or matches_printable_modify_other_keys(data, codepoint, MODIFIERS["shift"])

        if modifier != 0:
            return matches_kitty_sequence(
                data, codepoint, modifier
            ) or matches_printable_modify_other_keys(data, codepoint, modifier)

        return data == key or matches_kitty_sequence(data, codepoint, 0)

    return False


def format_parsed_key(
    codepoint: int, modifier: int, base_layout_key: int | None = None
) -> str | None:
    normalized_codepoint = normalize_kitty_functional_codepoint(codepoint)
    identity_codepoint = normalize_shifted_letter_identity_codepoint(normalized_codepoint, modifier)

    is_latin_letter = 97 <= identity_codepoint <= 122
    is_digit = 48 <= identity_codepoint <= 57
    try:
        is_known_symbol = chr(identity_codepoint) in SYMBOL_KEYS
    except ValueError:
        is_known_symbol = False

    effective_codepoint = identity_codepoint
    if not (is_latin_letter or is_digit or is_known_symbol) and base_layout_key is not None:
        effective_codepoint = base_layout_key

    key_name = None
    if effective_codepoint == CODEPOINTS["escape"]:
        key_name = "escape"
    elif effective_codepoint == CODEPOINTS["tab"]:
        key_name = "tab"
    elif effective_codepoint in (CODEPOINTS["enter"], CODEPOINTS["kpEnter"]):
        key_name = "enter"
    elif effective_codepoint == CODEPOINTS["space"]:
        key_name = "space"
    elif effective_codepoint == CODEPOINTS["backspace"]:
        key_name = "backspace"
    elif effective_codepoint == FUNCTIONAL_CODEPOINTS["delete"]:
        key_name = "delete"
    elif effective_codepoint == FUNCTIONAL_CODEPOINTS["insert"]:
        key_name = "insert"
    elif effective_codepoint == FUNCTIONAL_CODEPOINTS["home"]:
        key_name = "home"
    elif effective_codepoint == FUNCTIONAL_CODEPOINTS["end"]:
        key_name = "end"
    elif effective_codepoint == FUNCTIONAL_CODEPOINTS["pageUp"]:
        key_name = "pageUp"
    elif effective_codepoint == FUNCTIONAL_CODEPOINTS["pageDown"]:
        key_name = "pageDown"
    elif effective_codepoint == ARROW_CODEPOINTS["up"]:
        key_name = "up"
    elif effective_codepoint == ARROW_CODEPOINTS["down"]:
        key_name = "down"
    elif effective_codepoint == ARROW_CODEPOINTS["left"]:
        key_name = "left"
    elif effective_codepoint == ARROW_CODEPOINTS["right"]:
        key_name = "right"
    elif 48 <= effective_codepoint <= 57:
        key_name = chr(effective_codepoint)
    elif 97 <= effective_codepoint <= 122:
        key_name = chr(effective_codepoint)
    elif 32 <= effective_codepoint <= 126:
        try:
            char = chr(effective_codepoint)
            if char in SYMBOL_KEYS:
                key_name = char
        except ValueError:
            pass

    if not key_name:
        return None
    return format_key_name_with_modifiers(key_name, modifier)


def parse_key(data: str) -> str | None:
    kitty = parse_kitty_sequence(data)
    if kitty:
        return format_parsed_key(kitty.codepoint, kitty.modifier, kitty.baseLayoutKey)

    modify_other_keys = parse_modify_other_keys_sequence(data)
    if modify_other_keys:
        return format_parsed_key(modify_other_keys.codepoint, modify_other_keys.modifier)

    if _kitty_protocol_active:
        if data in ("\x1b\r", "\n"):
            return "shift+enter"

    legacy_sequence_key_id = LEGACY_SEQUENCE_KEY_IDS.get(data)
    if legacy_sequence_key_id:
        return legacy_sequence_key_id

    if data == "\x1b":
        return "escape"
    if data == "\x1c":
        return "ctrl+\\"
    if data == "\x1d":
        return "ctrl+]"
    if data == "\x1f":
        return "ctrl+-"
    if data == "\x1b\x1b":
        return "ctrl+alt+["
    if data == "\x1b\x1c":
        return "ctrl+alt+\\"
    if data == "\x1b\x1d":
        return "ctrl+alt+]"
    if data == "\x1b\x1f":
        return "ctrl+alt+-"
    if data == "\t":
        return "tab"
    if data in ("\r", "\n", "\x1bOM"):
        if not _kitty_protocol_active and data == "\n":
            return "enter"
        if data in ("\r", "\x1bOM"):
            return "enter"
    if data == "\x00":
        return "ctrl+space"
    if data == " ":
        return "space"
    if data == "\x7f":
        return "backspace"
    if data == "\x08":
        return "ctrl+backspace" if is_windows_terminal_session() else "backspace"
    if data == "\x1b[Z":
        return "shift+tab"
    if not _kitty_protocol_active and data == "\x1b\r":
        return "alt+enter"
    if not _kitty_protocol_active and data == "\x1b ":
        return "alt+space"
    if data in ("\x1b\x7f", "\x1b\b"):
        return "alt+backspace"
    if not _kitty_protocol_active and data == "\x1bB":
        return "alt+left"
    if not _kitty_protocol_active and data == "\x1bF":
        return "alt+right"
    if not _kitty_protocol_active and len(data) == 2 and data[0] == "\x1b":
        code = ord(data[1])
        if 1 <= code <= 26:
            return f"ctrl+alt+{chr(code + 96)}"
        if (97 <= code <= 122) or (48 <= code <= 57):
            return f"alt+{chr(code)}"
    if data == "\x1b[A":
        return "up"
    if data == "\x1b[B":
        return "down"
    if data == "\x1b[C":
        return "right"
    if data == "\x1b[D":
        return "left"
    if data in ("\x1b[H", "\x1bOH"):
        return "home"
    if data in ("\x1b[F", "\x1bOF"):
        return "end"
    if data == "\x1b[3~":
        return "delete"
    if data == "\x1b[5~":
        return "pageUp"
    if data == "\x1b[6~":
        return "pageDown"

    # Raw Ctrl+letter
    if len(data) == 1:
        code = ord(data[0])
        if 1 <= code <= 26:
            return f"ctrl+{chr(code + 96)}"
        if 32 <= code <= 126:
            return data

    return None


def decode_kitty_printable(data: str) -> str | None:
    match = re.match(r"^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$", data)
    if not match:
        return None

    codepoint = int(match.group(1))
    shifted_str = match.group(2)
    shiftedKey = int(shifted_str) if shifted_str and len(shifted_str) > 0 else None
    mod_str = match.group(4)
    modValue = int(mod_str) if mod_str else 1
    modifier = modValue - 1

    allowed_modifiers = MODIFIERS["shift"] | LOCK_MASK
    if (modifier & ~allowed_modifiers) != 0:
        return None
    if modifier & (MODIFIERS["alt"] | MODIFIERS["ctrl"]):
        return None

    effective_codepoint = codepoint
    if (modifier & MODIFIERS["shift"]) and shiftedKey is not None:
        effective_codepoint = shiftedKey

    effective_codepoint = normalize_kitty_functional_codepoint(effective_codepoint)
    if effective_codepoint < 32:
        return None

    try:
        return chr(effective_codepoint)
    except ValueError:
        return None


def decode_modify_other_keys_printable(data: str) -> str | None:
    parsed = parse_modify_other_keys_sequence(data)
    if not parsed:
        return None
    modifier = parsed.modifier & ~LOCK_MASK
    if (modifier & ~MODIFIERS["shift"]) != 0:
        return None
    if parsed.codepoint < 32:
        return None

    try:
        return chr(parsed.codepoint)
    except ValueError:
        return None


def decode_printable_key(data: str) -> str | None:
    return decode_kitty_printable(data) or decode_modify_other_keys_printable(data)
