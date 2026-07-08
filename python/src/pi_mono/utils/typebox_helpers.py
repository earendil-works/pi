from typing import Any, Sequence, Optional


def StringEnum(
    values: Sequence[str],
    description: Optional[str] = None,
    default: Optional[str] = None,
) -> dict[str, Any]:
    """Creates a string enum schema compatible with Google's API and other providers

    that don't support anyOf/const patterns.
    """
    schema: dict[str, Any] = {
        "type": "string",
        "enum": list(values),
    }
    if description is not None:
        schema["description"] = description
    if default is not None:
        schema["default"] = default
    return schema
