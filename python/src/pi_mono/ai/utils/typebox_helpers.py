"""TypeBox-like helpers for creating JSON schemas."""

from typing import Any, TypedDict


class StringEnumOptions(TypedDict, total=False):
    description: str
    default: str


def string_enum(
    values: list[str],
    options: StringEnumOptions | None = None,
) -> dict[str, Any]:
    """
    Creates a string enum schema compatible with Google's API and other providers
    that don't support anyOf/const patterns.

    Args:
        values: List of valid string values
        options: Optional dict with 'description' and/or 'default'

    Returns:
        JSON schema dict for a string enum

    Example:
        >>> OperationSchema = string_enum(
        ...     ["add", "subtract", "multiply", "divide"],
        ...     {"description": "The operation to perform"}
        ... )
    """
    schema: dict[str, Any] = {
        "type": "string",
        "enum": values,
    }
    if options:
        if options.get("description"):
            schema["description"] = options["description"]
        if options.get("default"):
            schema["default"] = options["default"]
    return schema


class NumberEnumOptions(TypedDict, total=False):
    description: str
    default: int | float


def number_enum(
    values: list[int | float],
    options: NumberEnumOptions | None = None,
) -> dict[str, Any]:
    """Creates a number enum schema."""
    schema: dict[str, Any] = {
        "type": "number",
        "enum": values,
    }
    if options:
        if options.get("description"):
            schema["description"] = options["description"]
        if options.get("default") is not None:
            schema["default"] = options["default"]
    return schema


def object_schema(
    properties: dict[str, dict[str, Any]],
    required: list[str] | None = None,
    additional_properties: bool | dict[str, Any] = False,
) -> dict[str, Any]:
    """Creates an object schema."""
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
    }
    if required:
        schema["required"] = required
    if additional_properties is not True:
        schema["additionalProperties"] = additional_properties
    return schema


def array_schema(
    items: dict[str, Any],
    min_items: int | None = None,
    max_items: int | None = None,
) -> dict[str, Any]:
    """Creates an array schema."""
    schema: dict[str, Any] = {
        "type": "array",
        "items": items,
    }
    if min_items is not None:
        schema["minItems"] = min_items
    if max_items is not None:
        schema["maxItems"] = max_items
    return schema
