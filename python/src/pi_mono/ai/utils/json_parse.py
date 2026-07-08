"""JSON parsing utilities with repair for malformed/streaming JSON."""

import json
import re
from typing import Any, TypeVar

T = TypeVar("T")

VALID_JSON_ESCAPES = {"\\", '"', "/", "b", "f", "n", "r", "t", "u"}


def _is_control_character(char: str) -> bool:
    code_point = ord(char)
    return 0x00 <= code_point <= 0x1F


def _escape_control_character(char: str) -> str:
    code_point = ord(char)
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
    return f"\\u{code_point:04x}"


def repair_json(json_str: str) -> str:
    """
    Repairs malformed JSON string literals by:
    - escaping raw control characters inside strings
    - doubling backslashes before invalid escape characters
    """
    repaired = ""
    in_string = False

    i = 0
    while i < len(json_str):
        char = json_str[i]

        if not in_string:
            repaired += char
            if char == '"':
                in_string = True
            i += 1
            continue

        if char == '"':
            repaired += char
            in_string = False
            i += 1
            continue

        if char == "\\":
            next_char = json_str[i + 1] if i + 1 < len(json_str) else None
            if next_char is None:
                repaired += "\\\\"
                i += 1
                continue

            if next_char == "u":
                # Check for valid Unicode escape
                unicode_digits = json_str[i + 2 : i + 6]
                if re.match(r"^[0-9a-fA-F]{4}$", unicode_digits):
                    repaired += f"\\u{unicode_digits}"
                    i += 6
                    continue

            if next_char in VALID_JSON_ESCAPES:
                repaired += f"\\{next_char}"
                i += 2
                continue

            # Invalid escape - double the backslash
            repaired += "\\\\"
            i += 1
            continue

        # Regular character - escape if control character
        if _is_control_character(char):
            repaired += _escape_control_character(char)
        else:
            repaired += char
        i += 1

    return repaired


def _try_partial_parse(partial_json: str) -> dict[str, Any] | None:
    """
    Simple partial JSON parser for streaming.
    Returns a parsed dict or None if cannot parse.
    """
    # Try to extract complete objects from partial JSON
    # This is a simplified version - just try to parse what we can
    try:
        # Add closing braces/brackets if needed
        test_json = partial_json
        open_braces = test_json.count("{") - test_json.count("}")
        open_brackets = test_json.count("[") - test_json.count("]")

        # Try to find the last complete object
        for _ in range(open_braces):
            test_json += "}"
        for _ in range(open_brackets):
            test_json += "]"

        return json.loads(test_json)
    except (json.JSONDecodeError, ValueError):
        return None


def parse_json_with_repair(json_str: str) -> Any:
    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        repaired = repair_json(json_str)
        if repaired != json_str:
            return json.loads(repaired)
        raise


def parse_streaming_json(partial_json: str | None) -> dict[str, Any]:
    """
    Attempts to parse potentially incomplete JSON during streaming.
    Always returns a valid object, even if the JSON is incomplete.
    """
    if not partial_json or partial_json.strip() == "":
        return {}

    try:
        return parse_json_with_repair(partial_json)
    except (json.JSONDecodeError, ValueError):
        pass

    # Try partial parse
    try:
        result = _try_partial_parse(partial_json)
        if result is not None:
            return result
    except (json.JSONDecodeError, ValueError):
        pass

    # Try repair then partial parse
    try:
        repaired = repair_json(partial_json)
        result = _try_partial_parse(repaired)
        if result is not None:
            return result
    except (json.JSONDecodeError, ValueError):
        pass

    return {}
