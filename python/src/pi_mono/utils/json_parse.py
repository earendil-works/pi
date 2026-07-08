import json
from typing import Any, NoReturn

# ==============================================================================
# Partial JSON Parsing (compatible with npm partial-json package)
# ==============================================================================


class PartialJSON(Exception):
    """Exception raised when JSON is incomplete/partial."""

    pass


class MalformedJSON(Exception):
    """Exception raised when JSON is malformed."""

    pass


class Allow:
    """Bits indicating what parts of JSON are allowed to be partial."""

    STR = 0b000000001
    NUM = 0b000000010
    ARR = 0b000000100
    OBJ = 0b000001000
    NULL = 0b000010000
    BOOL = 0b000100000
    NAN = 0b001000000
    INFINITY = 0b010000000
    _INFINITY = 0b100000000
    INF = INFINITY | _INFINITY
    SPECIAL = NULL | BOOL | INF | NAN
    ATOM = STR | NUM | SPECIAL
    COLLECTION = ARR | OBJ
    ALL = ATOM | COLLECTION


def js_substring(s: str, start: int, end: int) -> str:
    """Implement JavaScript-compatible substring behavior."""
    length = len(s)
    # Negative values are treated as 0
    start = max(0, start)
    end = max(0, end)
    # Cap to length
    start = min(length, start)
    end = min(length, end)
    # Swap if start > end
    if start > end:
        start, end = end, start
    return s[start:end]


def parse_json(json_string: str, allow: int = Allow.ALL) -> Any:
    """Parse incomplete JSON string using partial-json rules."""
    if not isinstance(json_string, str):
        raise TypeError(f"expecting str, got {type(json_string).__name__}")

    trimmed = json_string.strip()
    if not trimmed:
        raise ValueError(f"{json_string} is empty")

    length = len(trimmed)
    index = 0

    def mark_partial_json(msg: str) -> NoReturn:
        raise PartialJSON(f"{msg} at position {index}")

    def throw_malformed_error(msg: str) -> NoReturn:
        raise MalformedJSON(f"{msg} at position {index}")

    def skip_blank() -> None:
        nonlocal index
        while index < length and trimmed[index] in " \n\r\t":
            index += 1

    def parse_str() -> str:
        nonlocal index
        start = index
        escape = False
        index += 1  # skip initial quote

        while index < length and (trimmed[index] != '"' or (escape and trimmed[index - 1] == "\\")):
            if trimmed[index] == "\\":
                escape = not escape
            else:
                escape = False
            index += 1

        if index < length and trimmed[index] == '"':
            try:
                index += 1
                end = index - (1 if escape else 0)
                sub_str = js_substring(trimmed, start, end)
                return json.loads(sub_str)
            except Exception as e:
                throw_malformed_error(str(e))
        elif Allow.STR & allow:
            try:
                end = index - (1 if escape else 0)
                return json.loads(js_substring(trimmed, start, end) + '"')
            except Exception:
                last_backslash = trimmed[:index].rfind("\\")
                if last_backslash != -1:
                    return json.loads(js_substring(trimmed, start, last_backslash) + '"')

        mark_partial_json("Unterminated string literal")

    def parse_obj() -> dict[str, Any]:
        nonlocal index
        index += 1  # skip initial brace
        skip_blank()
        obj: dict[str, Any] = {}
        try:
            while index < length and trimmed[index] != "}":
                skip_blank()
                if index >= length and (Allow.OBJ & allow):
                    return obj
                key = parse_str()
                skip_blank()
                index += 1  # skip colon
                try:
                    value = parse_any()
                    obj[key] = value
                except Exception as e:
                    if Allow.OBJ & allow:
                        return obj
                    else:
                        raise e
                skip_blank()
                if index < length and trimmed[index] == ",":
                    index += 1  # skip comma
        except Exception:
            if Allow.OBJ & allow:
                return obj
            else:
                mark_partial_json("Expected '}' at end of object")
        index += 1  # skip final brace
        return obj

    def parse_arr() -> list[Any]:
        nonlocal index
        index += 1  # skip initial bracket
        arr: list[Any] = []
        try:
            while index < length and trimmed[index] != "]":
                arr.append(parse_any())
                skip_blank()
                if index < length and trimmed[index] == ",":
                    index += 1  # skip comma
        except Exception:
            if Allow.ARR & allow:
                return arr
            mark_partial_json("Expected ']' at end of array")
        index += 1  # skip final bracket
        return arr

    def parse_num() -> int | float:
        nonlocal index
        if index == 0:
            if trimmed == "-":
                throw_malformed_error("Not sure what '-' is")
            try:
                return json.loads(trimmed)
            except Exception as e:
                if Allow.NUM & allow:
                    try:
                        last_e = trimmed.rfind("e")
                        sub_val = js_substring(trimmed, 0, last_e)
                        return json.loads(sub_val)
                    except Exception:
                        pass
                throw_malformed_error(str(e))

        start = index
        if index < length and trimmed[index] == "-":
            index += 1
        while index < length and trimmed[index] not in ",]}":
            index += 1
        if index == length and not (Allow.NUM & allow):
            mark_partial_json("Unterminated number literal")
        try:
            return json.loads(js_substring(trimmed, start, index))
        except Exception as e:
            if trimmed[start:index] == "-":
                mark_partial_json("Not sure what '-' is")
            try:
                last_e = trimmed.rfind("e")
                sub_val = js_substring(trimmed, start, last_e)
                return json.loads(sub_val)
            except Exception:
                throw_malformed_error(str(e))

    def parse_any() -> Any:
        nonlocal index
        skip_blank()
        if index >= length:
            mark_partial_json("Unexpected end of input")
        char = trimmed[index]
        if char == '"':
            return parse_str()
        if char == "{":
            return parse_obj()
        if char == "[":
            return parse_arr()

        if trimmed[index : index + 4] == "null" or (
            Allow.NULL & allow and length - index < 4 and "null".startswith(trimmed[index:])
        ):
            index += 4
            return None
        if trimmed[index : index + 4] == "true" or (
            Allow.BOOL & allow and length - index < 4 and "true".startswith(trimmed[index:])
        ):
            index += 4
            return True
        if trimmed[index : index + 5] == "false" or (
            Allow.BOOL & allow and length - index < 5 and "false".startswith(trimmed[index:])
        ):
            index += 5
            return False
        if trimmed[index : index + 8] == "Infinity" or (
            Allow.INFINITY & allow and length - index < 8 and "Infinity".startswith(trimmed[index:])
        ):
            index += 8
            return float("inf")
        if trimmed[index : index + 9] == "-Infinity" or (
            Allow._INFINITY & allow
            and 1 < length - index < 9
            and "-Infinity".startswith(trimmed[index:])
        ):
            index += 9
            return float("-inf")
        if trimmed[index : index + 3] == "NaN" or (
            Allow.NAN & allow and length - index < 3 and "NaN".startswith(trimmed[index:])
        ):
            index += 3
            return float("nan")

        return parse_num()

    return parse_any()


# ==============================================================================
# JSON Repair and Parse with Repair
# ==============================================================================

VALID_JSON_ESCAPES = {'"', "\\", "/", "b", "f", "n", "r", "t", "u"}


def is_control_character(char: str) -> bool:
    """Check if character is a control character (U+0000 to U+001F)."""
    if not char:
        return False
    code_point = ord(char[0])
    return 0x00 <= code_point <= 0x1F


def escape_control_character(char: str) -> str:
    """Escape control character to its JSON representation."""
    if char == "\b":
        return "\\b"
    if char == "\f":
        return "\\f"
    if char == "\n":
        return "\\n"
    if char == "\r":
        return "\\r"
    if char == "\t":
        return "\\t"
    code_point = ord(char[0])
    return f"\\u{code_point:04x}"


def repair_json(json_str: str) -> str:
    """Repairs malformed JSON string literals by escaping raw control characters

    inside strings and doubling backslashes before invalid escape characters.
    """
    repaired = []
    in_string = False
    length = len(json_str)
    index = 0

    while index < length:
        char = json_str[index]

        if not in_string:
            repaired.append(char)
            if char == '"':
                in_string = True
            index += 1
            continue

        if char == '"':
            repaired.append(char)
            in_string = False
            index += 1
            continue

        if char == "\\":
            if index + 1 >= length:
                repaired.append("\\\\")
                index += 1
                continue

            next_char = json_str[index + 1]

            if next_char == "u":
                unicode_digits = json_str[index + 2 : index + 6]
                if len(unicode_digits) == 4 and all(
                    c in "0123456789abcdefABCDEF" for c in unicode_digits
                ):
                    repaired.append(f"\\u{unicode_digits}")
                    index += 6
                    continue

            if next_char in VALID_JSON_ESCAPES:
                repaired.append(f"\\{next_char}")
                index += 2
                continue

            repaired.append("\\\\")
            index += 1
            continue

        if is_control_character(char):
            repaired.append(escape_control_character(char))
        else:
            repaired.append(char)
        index += 1

    return "".join(repaired)


def parse_json_with_repair(json_str: str) -> Any:
    """Parse JSON string, attempting repair if parsing fails."""
    try:
        return json.loads(json_str)
    except Exception as error:
        repaired_json = repair_json(json_str)
        if repaired_json != json_str:
            return json.loads(repaired_json)
        raise error


def parse_streaming_json(partial_json: str | None) -> Any:
    """Attempts to parse potentially incomplete JSON during streaming.

    Always returns a valid object, even if the JSON is incomplete.
    """
    if not partial_json or partial_json.strip() == "":
        return {}

    try:
        return parse_json_with_repair(partial_json)
    except Exception:
        try:
            result = parse_json(partial_json)
            return result if result is not None else {}
        except Exception:
            try:
                result = parse_json(repair_json(partial_json))
                return result if result is not None else {}
            except Exception:
                return {}
