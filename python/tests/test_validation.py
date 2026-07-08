import pytest
from pi_mono.utils.validation import validate_tool_arguments, validate_tool_call
from pi_mono.ai.types import Tool, ToolCall


def test_validate_tool_arguments_success():
    tool: Tool = {
        "name": "calculate",
        "description": "Run a calculation",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {"type": "string"},
                "round": {"type": "boolean"},
            },
            "required": ["expression"],
        },
    }

    tool_call: ToolCall = {
        "name": "calculate",
        "arguments": {"expression": "2+2", "round": "true"},
    }

    res = validate_tool_arguments(tool, tool_call)
    assert res == {"expression": "2+2", "round": True}


def test_validate_tool_arguments_coercion():
    tool: Tool = {
        "name": "test_coerce",
        "description": "Test coercion",
        "parameters": {
            "type": "object",
            "properties": {
                "val_int": {"type": "integer"},
                "val_num": {"type": "number"},
                "val_bool": {"type": "boolean"},
                "val_str": {"type": "string"},
                "val_null": {"type": "null"},
            },
        },
    }

    tool_call: ToolCall = {
        "name": "test_coerce",
        "arguments": {
            "val_int": "42",
            "val_num": "3.14",
            "val_bool": 1,
            "val_str": True,
            "val_null": "",
        },
    }

    res = validate_tool_arguments(tool, tool_call)
    assert res == {
        "val_int": 42,
        "val_num": 3.14,
        "val_bool": True,
        "val_str": "true",
        "val_null": None,
    }


def test_validate_tool_arguments_missing_required():
    tool: Tool = {
        "name": "write_file",
        "description": "Write a file",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    }

    tool_call: ToolCall = {
        "name": "write_file",
        "arguments": {"path": "/tmp/test.txt"},
    }

    with pytest.raises(ValueError) as exc_info:
        validate_tool_arguments(tool, tool_call)

    assert "Validation failed for tool" in str(exc_info.value)
    assert "content: Expected required property" in str(exc_info.value)


def test_validate_tool_arguments_enum():
    tool: Tool = {
        "name": "select_theme",
        "description": "Select a theme",
        "parameters": {
            "type": "object",
            "properties": {
                "theme": {
                    "type": "string",
                    "enum": ["light", "dark"],
                }
            },
        },
    }

    tool_call: ToolCall = {
        "name": "select_theme",
        "arguments": {"theme": "blue"},
    }

    with pytest.raises(ValueError) as exc_info:
        validate_tool_arguments(tool, tool_call)

    assert "theme: Expected value to be one of" in str(exc_info.value)


def test_validate_tool_arguments_nested_object():
    tool: Tool = {
        "name": "nested",
        "description": "Nested object",
        "parameters": {
            "type": "object",
            "properties": {
                "info": {
                    "type": "object",
                    "properties": {"age": {"type": "integer"}},
                    "required": ["age"],
                }
            },
        },
    }

    tool_call: ToolCall = {
        "name": "nested",
        "arguments": {"info": {"age": "25"}},
    }

    res = validate_tool_arguments(tool, tool_call)
    assert res == {"info": {"age": 25}}


def test_validate_tool_call_not_found():
    tools = []
    tool_call: ToolCall = {"name": "non_existent", "arguments": {}}
    with pytest.raises(ValueError) as exc_info:
        validate_tool_call(tools, tool_call)
    assert 'Tool "non_existent" not found' in str(exc_info.value)
