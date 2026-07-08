from pi_mono.utils.typebox_helpers import StringEnum


def test_string_enum_basic():
    schema = StringEnum(["a", "b", "c"])
    assert schema == {
        "type": "string",
        "enum": ["a", "b", "c"],
    }


def test_string_enum_with_description_and_default():
    schema = StringEnum(
        ["add", "subtract"],
        description="The mathematical operation",
        default="add",
    )
    assert schema == {
        "type": "string",
        "enum": ["add", "subtract"],
        "description": "The mathematical operation",
        "default": "add",
    }
