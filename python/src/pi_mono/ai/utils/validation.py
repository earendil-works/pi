"""Tool call validation utilities using JSON Schema."""

import json
from functools import lru_cache
from typing import Any, TypedDict

try:
    import jsonschema
    from jsonschema import Draft7Validator, ValidationError

    HAS_JSONSCHEMA = True
except ImportError:
    jsonschema = None
    Draft7Validator = None
    ValidationError = Exception
    HAS_JSONSCHEMA = False


def _matches_json_type(value: Any, type_: str) -> bool:
    """Check if value matches JSON schema type."""
    if type_ == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_ == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_ == "boolean":
        return isinstance(value, bool)
    if type_ == "string":
        return isinstance(value, str)
    if type_ == "null":
        return value is None
    if type_ == "array":
        return isinstance(value, list)
    if type_ == "object":
        return isinstance(value, dict)
    return False


def _coerce_primitive_by_type(value: Any, type_: str) -> Any:
    """Coerce primitive value to target type."""
    if type_ == "number":
        if value is None:
            return 0
        if isinstance(value, str) and value.strip():
            try:
                parsed = float(value)
                if parsed == int(parsed):
                    return int(parsed)
                return parsed
            except ValueError:
                pass
        if isinstance(value, bool):
            return 1 if value else 0
        return value

    if type_ == "integer":
        if value is None:
            return 0
        if isinstance(value, str) and value.strip():
            try:
                parsed = float(value)
                if parsed == int(parsed):
                    return int(parsed)
            except ValueError:
                pass
        if isinstance(value, bool):
            return 1 if value else 0
        return value

    if type_ == "boolean":
        if value is None:
            return False
        if isinstance(value, str):
            if value == "true":
                return True
            if value == "false":
                return False
        if isinstance(value, (int, float)):
            return value != 0
        return value

    if type_ == "string":
        if value is None:
            return ""
        if isinstance(value, (int, float, bool)):
            return str(value)
        return value

    if type_ == "null":
        if value in ("", 0, False):
            return None
        return value

    return value


def _get_schema_types(schema: dict) -> list[str]:
    """Get types from schema."""
    if isinstance(schema.get("type"), str):
        return [schema["type"]]
    if isinstance(schema.get("type"), list):
        return [t for t in schema["type"] if isinstance(t, str)]
    return []


def _apply_schema_object_coercion(value: dict, schema: dict) -> None:
    """Apply coercion to object properties."""
    properties = schema.get("properties", {})
    defined_keys = set(properties.keys())

    for key, prop_schema in properties.items():
        if key not in value:
            continue
        value[key] = coerce_with_json_schema(value[key], prop_schema)

    additional_props = schema.get("additionalProperties")
    if additional_props and isinstance(additional_props, dict):
        for key, prop_value in value.items():
            if key in defined_keys:
                continue
            value[key] = coerce_with_json_schema(prop_value, additional_props)


def _apply_schema_array_coercion(value: list, schema: dict) -> None:
    """Apply coercion to array items."""
    items = schema.get("items")
    if isinstance(items, list):
        for index, item_schema in enumerate(items):
            if index >= len(value):
                break
            if not item_schema:
                continue
            value[index] = coerce_with_json_schema(value[index], item_schema)
        return

    if isinstance(items, dict):
        for index in range(len(value)):
            value[index] = coerce_with_json_schema(value[index], items)


def _coerce_with_union_schema(value: Any, schemas: list[dict], validator: Any = None) -> Any:
    """Try coercion with union/anyOf/oneOf schemas."""
    for schema in schemas:
        candidate = json.loads(json.dumps(value)) if isinstance(value, (dict, list)) else value
        coerced = coerce_with_json_schema(candidate, schema)
        if validator and validator.validate(coerced):
            return coerced
    return value


def coerce_with_json_schema(value: Any, schema: dict) -> Any:
    """Recursively coerce value to match JSON schema."""
    next_value = value

    # Handle allOf
    if isinstance(schema.get("allOf"), list):
        for nested in schema["allOf"]:
            next_value = coerce_with_json_schema(next_value, nested)

    # Handle anyOf
    if isinstance(schema.get("anyOf"), list):
        next_value = _coerce_with_union_schema(next_value, schema["anyOf"])

    # Handle oneOf
    if isinstance(schema.get("oneOf"), list):
        next_value = _coerce_with_union_schema(next_value, schema["oneOf"])

    # Type coercion
    schema_types = _get_schema_types(schema)
    matches_union_member = len(schema_types) > 1 and any(
        _matches_json_type(next_value, t) for t in schema_types
    )

    if schema_types and not matches_union_member:
        for schema_type in schema_types:
            candidate = _coerce_primitive_by_type(next_value, schema_type)
            if candidate != next_value:
                next_value = candidate
                break

    # Object coercion
    if "object" in schema_types and isinstance(next_value, dict):
        _apply_schema_object_coercion(next_value, schema)

    # Array coercion
    if "array" in schema_types and isinstance(next_value, list):
        _apply_schema_array_coercion(next_value, schema)

    return next_value


@lru_cache(maxsize=128)
def _get_validator(schema_str: str):
    """Get compiled validator for schema (cached)."""
    if not HAS_JSONSCHEMA:
        return None
    schema = json.loads(schema_str)
    return Draft7Validator(schema)


def validate_tool_arguments(
    tool_parameters: dict[str, Any],
    tool_call_args: dict[str, Any],
) -> dict[str, Any]:
    """
    Validate tool call arguments against the tool's JSON Schema.

    Args:
        tool_parameters: JSON Schema for tool parameters
        tool_call_args: Arguments from the tool call

    Returns:
        Validated (and potentially coerced) arguments

    Raises:
        ValidationError: If validation fails
    """
    if not HAS_JSONSCHEMA:
        # Without jsonschema, just return args with basic coercion
        return coerce_with_json_schema(tool_call_args, tool_parameters)

    # Attempt type coercion
    args = coerce_with_json_schema(json.loads(json.dumps(tool_call_args)), tool_parameters)

    # Validate
    validator = _get_validator(json.dumps(tool_parameters))
    if validator:
        errors = list(validator.iter_errors(args))
        if errors:
            error_msgs = []
            for error in errors:
                path = ".".join(str(p) for p in error.path) if error.path else "root"
                error_msgs.append(f"  - {path}: {error.message}")
            error_str = "\n".join(error_msgs) or "Unknown validation error"
            raise ValidationError(
                f"Validation failed:\n{error_str}\n\nReceived arguments:\n"
                f"{json.dumps(tool_call_args, indent=2)}"
            )

    return args


def format_validation_error(error: ValidationError) -> str:
    """Format a validation error for display."""
    if not HAS_JSONSCHEMA or not hasattr(error, "path"):
        return str(error)

    path = ".".join(str(p) for p in error.path) if error.path else "root"
    return f"{path}: {error.message}"


# Type definitions for compatibility
class Tool(TypedDict, total=False):
    name: str
    description: str
    parameters: dict[str, Any]


class ToolCall(TypedDict):
    name: str
    arguments: dict[str, Any]


def find_tool(tools: list[Tool], name: str) -> Tool | None:
    """Find a tool by name."""
    for tool in tools:
        if tool.get("name") == name:
            return tool
    return None


def validate_tool_call(
    tools: list[Tool],
    tool_call: ToolCall,
) -> dict[str, Any]:
    """
    Find a tool by name and validate the tool call arguments.

    Args:
        tools: Array of tool definitions
        tool_call: The tool call from the LLM

    Returns:
        Validated arguments

    Raises:
        ValueError: If tool is not found or validation fails
    """
    tool = find_tool(tools, tool_call["name"])
    if not tool:
        raise ValueError(f'Tool "{tool_call["name"]}" not found')

    return validate_tool_arguments(tool.get("parameters", {}), tool_call["arguments"])
