from typing import Any
from pi_mono.utils.diagnostics import (
    format_thrown_value,
    extract_diagnostic_error,
    create_assistant_message_diagnostic,
    append_assistant_message_diagnostic,
)


class CustomMessage:
    def __init__(self) -> None:
        self.diagnostics: list[Any] = []


def test_format_thrown_value():
    assert format_thrown_value("error message") == "error message"
    assert format_thrown_value(123) == "123"
    assert format_thrown_value(ValueError("invalid value")) == "invalid value"
    assert format_thrown_value(RuntimeError()) == "RuntimeError"


def test_extract_diagnostic_error_non_exception():
    info = extract_diagnostic_error("something failed")
    assert info["name"] == "ThrownValue"
    assert info["message"] == "something failed"
    assert "stack" not in info
    assert "code" not in info


def test_extract_diagnostic_error_standard_exception():
    err = ValueError("test error")
    info = extract_diagnostic_error(err)
    assert info["name"] == "ValueError"
    assert info["message"] == "test error"
    assert "stack" not in info

    # Raise exception to populate traceback
    try:
        raise ValueError("test raised")
    except ValueError as e:
        info_raised = extract_diagnostic_error(e)
        assert info_raised["name"] == "ValueError"
        assert info_raised["message"] == "test raised"
        assert "stack" in info_raised
        assert "ValueError: test raised" in info_raised["stack"]


def test_extract_diagnostic_error_with_code():
    err = Exception("error with code")
    setattr(err, "code", "ERR_CODE_123")
    info = extract_diagnostic_error(err)
    assert info["code"] == "ERR_CODE_123"

    err_int = Exception("error with numeric code")
    setattr(err_int, "code", 500)
    info_int = extract_diagnostic_error(err_int)
    assert info_int["code"] == 500


def test_create_assistant_message_diagnostic():
    err = ValueError("diagnostic error")
    diag = create_assistant_message_diagnostic("api_error", err, {"model": "gpt-4"})
    assert diag["type"] == "api_error"
    assert isinstance(diag["timestamp"], int)
    assert diag["error"]["name"] == "ValueError"
    assert diag["error"]["message"] == "diagnostic error"
    assert diag["details"] == {"model": "gpt-4"}


def test_append_assistant_message_diagnostic_dict():
    message: dict[str, Any] = {}
    diag = create_assistant_message_diagnostic("test", ValueError("err"))
    append_assistant_message_diagnostic(message, diag)
    assert "diagnostics" in message
    assert message["diagnostics"] == [diag]


def test_append_assistant_message_diagnostic_object():
    message = CustomMessage()
    diag = create_assistant_message_diagnostic("test", ValueError("err"))
    append_assistant_message_diagnostic(message, diag)
    assert message.diagnostics == [diag]
