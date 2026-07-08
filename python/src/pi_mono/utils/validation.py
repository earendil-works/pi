import copy
import json
from typing import Any, List, Tuple
from pi_mono.ai.types import Tool, ToolCall


def format_validation_path(path: List[str]) -> str:
    """Format path into a dot-separated string, returning 'root' if empty."""
    return ".".join(path) if path else "root"


def _coerce_primitive(value: Any, expected_type: str) -> Any:
    """Coerce primitive type to match schema requirements exactly as in TS."""
    if expected_type == "number":
        if value is None:
            return 0.0
        if isinstance(value, str) and value.strip() != "":
            try:
                return float(value)
            except ValueError:
                pass
        if isinstance(value, bool):
            return 1.0 if value else 0.0

    elif expected_type == "integer":
        if value is None:
            return 0
        if isinstance(value, str) and value.strip() != "":
            try:
                val = float(value)
                if val.is_integer():
                    return int(val)
            except ValueError:
                pass
        if isinstance(value, bool):
            return 1 if value else 0

    elif expected_type == "boolean":
        if value is None:
            return False
        if isinstance(value, str):
            if value == "true":
                return True
            if value == "false":
                return False
        if isinstance(value, (int, float)):
            if value == 1:
                return True
            if value == 0:
                return False

    elif expected_type == "string":
        if value is None:
            return ""
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)

    elif expected_type == "null":
        if value in ("", 0, False):
            return None

    return value


def validate_value(value: Any, schema: Any, path: List[str], errors: List[Tuple[str, str]]) -> Any:
    """Recursively validates and coerces values against a JSON Schema."""
    if not isinstance(schema, dict):
        return value

    # 1. Handle allOf
    if "allOf" in schema:
        coerced = value
        for subschema in schema["allOf"]:
            sub_errors_all: List[Tuple[str, str]] = []
            coerced = validate_value(coerced, subschema, path, sub_errors_all)
            if sub_errors_all:
                errors.extend(sub_errors_all)
        return coerced

    # 2. Handle anyOf
    if "anyOf" in schema:
        best_coerced = value
        matched = False
        for subschema in schema["anyOf"]:
            sub_errors_any: List[Tuple[str, str]] = []
            coerced = validate_value(copy.deepcopy(value), subschema, path, sub_errors_any)
            if not sub_errors_any:
                matched = True
                best_coerced = coerced
                break
        if not matched:
            errors.append((format_validation_path(path), "Expected anyOf member to match"))
        return best_coerced

    # 3. Handle oneOf
    if "oneOf" in schema:
        matches = []
        for subschema in schema["oneOf"]:
            sub_errors_one: List[Tuple[str, str]] = []
            coerced = validate_value(copy.deepcopy(value), subschema, path, sub_errors_one)
            if not sub_errors_one:
                matches.append(coerced)
        if len(matches) != 1:
            errors.append(
                (
                    format_validation_path(path),
                    "Expected exactly one of oneOf members to match",
                )
            )
            return value
        return matches[0]

    # Get types
    schema_types = []
    if "type" in schema:
        t = schema["type"]
        if isinstance(t, str):
            schema_types = [t]
        elif isinstance(t, list):
            schema_types = t

    # Check and coerce primitive types
    current_type_matches = False
    if schema_types:
        for st in schema_types:
            if st == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
                current_type_matches = True
            elif st == "integer" and isinstance(value, int) and not isinstance(value, bool):
                current_type_matches = True
            elif st == "boolean" and isinstance(value, bool):
                current_type_matches = True
            elif st == "string" and isinstance(value, str):
                current_type_matches = True
            elif st == "null" and value is None:
                current_type_matches = True
            elif st == "array" and isinstance(value, list):
                current_type_matches = True
            elif st == "object" and isinstance(value, dict):
                current_type_matches = True

        if not current_type_matches:
            # Attempt coercion
            for st in schema_types:
                coerced_value = _coerce_primitive(value, st)
                if coerced_value is not value:
                    value = coerced_value
                    current_type_matches = True
                    break

    # If types specified and none matched (after coercion)
    if schema_types and not current_type_matches:
        expected = "/".join(schema_types)
        errors.append((format_validation_path(path), f"Expected {expected}"))
        return value

    # Validate based on the matched type
    if isinstance(value, str):
        if "enum" in schema:
            if value not in schema["enum"]:
                errors.append(
                    (
                        format_validation_path(path),
                        f"Expected value to be one of: {schema['enum']}",
                    )
                )
        if "minLength" in schema:
            if len(value) < schema["minLength"]:
                errors.append(
                    (
                        format_validation_path(path),
                        f"Expected string length to be >= {schema['minLength']}",
                    )
                )

    elif isinstance(value, list):
        if "minItems" in schema:
            if len(value) < schema["minItems"]:
                errors.append(
                    (
                        format_validation_path(path),
                        f"Expected minItems to be >= {schema['minItems']}",
                    )
                )
        if "items" in schema:
            items_schema = schema["items"]
            if isinstance(items_schema, list):
                for idx, val in enumerate(value):
                    if idx < len(items_schema):
                        value[idx] = validate_value(
                            val, items_schema[idx], path + [str(idx)], errors
                        )
            elif isinstance(items_schema, dict):
                for idx, val in enumerate(value):
                    value[idx] = validate_value(val, items_schema, path + [str(idx)], errors)

    elif isinstance(value, dict):
        required = schema.get("required", [])
        for req in required:
            if req not in value:
                req_path = path + [req]
                errors.append((format_validation_path(req_path), "Expected required property"))

        properties = schema.get("properties", {})
        for prop_name, prop_schema in properties.items():
            if prop_name in value:
                value[prop_name] = validate_value(
                    value[prop_name], prop_schema, path + [prop_name], errors
                )

        add_prop = schema.get("additionalProperties")
        if add_prop is False:
            for k in value:
                if k not in properties:
                    errors.append((format_validation_path(path + [k]), "Unexpected property"))
        elif isinstance(add_prop, dict):
            for k in value:
                if k not in properties:
                    value[k] = validate_value(value[k], add_prop, path + [k], errors)

    return value


def validate_tool_arguments(tool: Tool, tool_call: ToolCall) -> Any:
    """Validates and coerces tool call arguments against the tool's JSON schema."""
    args = copy.deepcopy(tool_call.get("arguments", {}))
    errors: List[Tuple[str, str]] = []

    coerced = validate_value(args, tool.get("parameters", {}), [], errors)

    if not errors:
        return coerced

    error_lines = []
    for path, msg in errors:
        error_lines.append(f"  - {path}: {msg}")

    errors_str = "\n".join(error_lines) or "Unknown validation error"
    errorMessage = (
        f"Validation failed for tool \"{tool_call.get('name')}\":\n"
        f"{errors_str}\n\n"
        f"Received arguments:\n"
        f"{json.dumps(tool_call.get('arguments', {}), indent=2)}"
    )
    raise ValueError(errorMessage)


def validate_tool_call(tools: List[Tool], tool_call: ToolCall) -> Any:
    """Finds a tool by name and validates the tool call arguments against its schema."""
    tool = next((t for t in tools if t.get("name") == tool_call.get("name")), None)
    if not tool:
        raise ValueError(f"Tool \"{tool_call.get('name')}\" not found")
    return validate_tool_arguments(tool, tool_call)
