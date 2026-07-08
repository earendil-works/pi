import pytest
from pi_mono.utils.json_parse import (
    repair_json,
    parse_json,
    parse_json_with_repair,
    parse_streaming_json,
    MalformedJSON,
)


def test_repair_json():
    # Escapes raw control characters in string literals
    raw_newline_json = '{"text": "Hello\nWorld"}'
    repaired_newline = repair_json(raw_newline_json)
    assert repaired_newline == '{"text": "Hello\\nWorld"}'

    # Doubles backslash on invalid escape character
    invalid_escape_json = '{"path": "C:\\Windows\\System32"}'
    repaired_escape = repair_json(invalid_escape_json)
    assert repaired_escape == '{"path": "C:\\\\Windows\\\\System32"}'

    # Preserves valid escape sequences
    valid_escapes_json = '{"escapes": "\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u1234"}'
    assert repair_json(valid_escapes_json) == valid_escapes_json


def test_parse_json_with_repair():
    # Valid JSON parses normally
    assert parse_json_with_repair('{"a": 1}') == {"a": 1}

    # Malformed JSON with control characters gets repaired and parsed
    assert parse_json_with_repair('{"text": "Line1\nLine2"}') == {"text": "Line1\nLine2"}

    # Totally invalid JSON throws error
    with pytest.raises(Exception):
        parse_json_with_repair('{"a": 1')


def test_parse_json_partial():
    # Partial object
    assert parse_json('{"a": 1, "b":') == {"a": 1}
    assert parse_json('[{"a": 1, "b": 2}, {"a": 3,') == [{"a": 1, "b": 2}, {"a": 3}]

    # Partial array
    assert parse_json("[1, 2,") == [1, 2]
    assert parse_json("[1, 2, 3") == [1, 2, 3]

    # Partial string
    assert parse_json('{"text": "hello') == {"text": "hello"}
    assert parse_json('{"text": "hello \\u12') == {"text": "hello "}

    # Partial boolean / null
    assert parse_json("tr") is True
    assert parse_json("fa") is False
    assert parse_json("nu") is None

    # Partial numbers
    with pytest.raises(MalformedJSON):
        parse_json("123.")
    assert parse_json("1.23e") == 1.23

    # Malformed cases raise appropriate exception
    with pytest.raises(MalformedJSON):
        parse_json("-")


def test_parse_streaming_json():
    # None / Empty inputs
    assert parse_streaming_json(None) == {}
    assert parse_streaming_json("") == {}
    assert parse_streaming_json("   ") == {}

    # Complete JSON
    assert parse_streaming_json('{"foo": "bar"}') == {"foo": "bar"}

    # Incomplete JSON
    assert parse_streaming_json('{"name": "John Doe", "courses": ["Math"') == {
        "name": "John Doe",
        "courses": ["Math"],
    }
    assert parse_streaming_json('[{"a": 1, "b": 2}, {"a": 3,') == [{"a": 1, "b": 2}, {"a": 3}]

    # Completely garbage text returns empty dict
    assert parse_streaming_json("this is not json") == {}
