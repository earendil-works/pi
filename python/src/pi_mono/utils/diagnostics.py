import time
import traceback
from typing import Any, NotRequired, TypedDict


class DiagnosticErrorInfo(TypedDict):
    name: NotRequired[str]
    message: str
    stack: NotRequired[str]
    code: NotRequired[str | int]


class AssistantMessageDiagnostic(TypedDict):
    type: str
    timestamp: int  # Timestamp in milliseconds
    error: NotRequired[DiagnosticErrorInfo]
    details: NotRequired[dict[str, Any]]


def format_thrown_value(value: object) -> str:
    """Format a thrown/raised value into a string message."""
    if isinstance(value, BaseException):
        return str(value) or value.__class__.__name__
    if isinstance(value, str):
        return value
    return str(value)


def extract_diagnostic_error(error: object) -> DiagnosticErrorInfo:
    """Extract diagnostic error details from an exception or custom object."""
    if not isinstance(error, BaseException):
        return {"name": "ThrownValue", "message": format_thrown_value(error)}

    code_val = getattr(error, "code", None)
    code: str | int | None = None
    if isinstance(code_val, (str, int)):
        code = code_val

    stack: str | None = None
    if error.__traceback__ is not None:
        stack = "".join(traceback.format_exception(type(error), error, error.__traceback__))

    info: DiagnosticErrorInfo = {
        "name": error.__class__.__name__,
        "message": str(error) or error.__class__.__name__,
    }
    if stack is not None:
        info["stack"] = stack
    if code is not None:
        info["code"] = code

    return info


def create_assistant_message_diagnostic(
    type_str: str,
    error: object,
    details: dict[str, Any] | None = None,
) -> AssistantMessageDiagnostic:
    """Create a diagnostic record for assistant message processing errors."""
    diag: AssistantMessageDiagnostic = {
        "type": type_str,
        "timestamp": int(time.time() * 1000),
        "error": extract_diagnostic_error(error),
    }
    if details is not None:
        diag["details"] = details
    return diag


def append_assistant_message_diagnostic(
    message: Any,
    diagnostic: AssistantMessageDiagnostic,
) -> None:
    """Append a diagnostic log to a message's diagnostics list."""
    if isinstance(message, dict):
        diagnostics = message.setdefault("diagnostics", [])
        diagnostics.append(diagnostic)
    else:
        diagnostics = getattr(message, "diagnostics", None)
        if diagnostics is None:
            diagnostics = []
            setattr(message, "diagnostics", diagnostics)
        diagnostics.append(diagnostic)
