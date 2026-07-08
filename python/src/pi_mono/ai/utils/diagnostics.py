import traceback
from typing import Any, TypedDict


class DiagnosticErrorInfo(TypedDict, total=False):
    name: str
    message: str
    stack: str
    code: str | int


class AssistantMessageDiagnostic(TypedDict, total=False):
    type: str
    timestamp: int
    error: DiagnosticErrorInfo
    details: dict[str, Any]


def format_thrown_value(value: Any) -> str:
    if isinstance(value, Exception):
        return value.args[0] if value.args else type(value).__name__
    if isinstance(value, str):
        return value
    return str(value)


def extract_diagnostic_error(error: Any) -> DiagnosticErrorInfo:
    if not isinstance(error, Exception):
        return {"name": "ThrownValue", "message": format_thrown_value(error)}

    code = getattr(error, "code", None)
    result: DiagnosticErrorInfo = {
        "name": type(error).__name__,
        "message": str(error) or type(error).__name__,
        "stack": "".join(traceback.format_tb(error.__traceback__)) if error.__traceback__ else "",
    }
    if isinstance(code, (str, int)):
        result["code"] = code
    return result


def create_assistant_message_diagnostic(
    type_: str, error: Any, details: dict[str, Any] | None = None
) -> AssistantMessageDiagnostic:
    return {
        "type": type_,
        "timestamp": int(__import__("time").time() * 1000),
        "error": extract_diagnostic_error(error),
        "details": details or {},
    }


def append_assistant_message_diagnostic(
    message: dict[str, Any],
    diagnostic: AssistantMessageDiagnostic,
) -> None:
    message["diagnostics"] = [*message.get("diagnostics", []), diagnostic]
