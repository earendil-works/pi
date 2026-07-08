import os
import pytest
from pi_mono.core.resolve_config_value import (
    resolve_config_value,
    resolve_config_value_or_throw,
    resolve_headers,
    resolve_headers_or_throw,
    is_command_config_value,
    is_config_value_configured,
    is_legacy_env_var_name_config_value,
    get_config_value_env_var_name,
    get_config_value_env_var_names,
    get_missing_config_value_env_var_names,
    clear_config_value_cache,
)


def test_resolve_config_value_literal():
    assert resolve_config_value("plain_value") == "plain_value"
    assert resolve_config_value("$$plain") == "$plain"
    assert resolve_config_value("$$!plain") == "$!plain"


def test_resolve_config_value_env_vars():
    os.environ["TEST_CONFIG_ENV_1"] = "val1"
    os.environ["TEST_CONFIG_ENV_2"] = "val2"

    assert resolve_config_value("$TEST_CONFIG_ENV_1") == "val1"
    assert resolve_config_value("${TEST_CONFIG_ENV_2}") == "val2"
    assert resolve_config_value("prefix_${TEST_CONFIG_ENV_1}_suffix") == "prefix_val1_suffix"

    # Missing env variable
    assert resolve_config_value("$TEST_CONFIG_ENV_MISSING") is None
    assert resolve_config_value("prefix_${TEST_CONFIG_ENV_MISSING}") is None


def test_resolve_config_value_or_throw():
    os.environ["TEST_CONFIG_ENV_1"] = "val1"

    assert resolve_config_value_or_throw("$TEST_CONFIG_ENV_1", "desc") == "val1"

    with pytest.raises(ValueError) as exc:
        resolve_config_value_or_throw("$TEST_CONFIG_ENV_MISSING", "my_var")
    assert "Failed to resolve my_var from environment variable: TEST_CONFIG_ENV_MISSING" in str(
        exc.value
    )


def test_resolve_headers():
    os.environ["TEST_HEADER_ENV"] = "header_val"

    headers = {
        "Authorization": "Bearer $TEST_HEADER_ENV",
        "Content-Type": "application/json",
        "X-Missing": "Prefix_$TEST_MISSING_VAR",
    }

    resolved = resolve_headers(headers)
    assert resolved is not None
    assert resolved["Authorization"] == "Bearer header_val"
    assert resolved["Content-Type"] == "application/json"
    # X-Missing has missing env var, so it is skipped
    assert "X-Missing" not in resolved


def test_resolve_headers_or_throw():
    os.environ["TEST_HEADER_ENV"] = "header_val"

    headers = {
        "Authorization": "Bearer $TEST_HEADER_ENV",
    }
    assert resolve_headers_or_throw(headers, "test") == {"Authorization": "Bearer header_val"}

    bad_headers = {
        "Authorization": "Bearer $TEST_MISSING_VAR",
    }
    with pytest.raises(ValueError):
        resolve_headers_or_throw(bad_headers, "test")


def test_is_command_config_value():
    assert is_command_config_value("!echo hello") is True
    assert is_command_config_value("echo hello") is False


def test_is_config_value_configured():
    os.environ["TEST_CONFIG_ENV_1"] = "val1"
    assert is_config_value_configured("$TEST_CONFIG_ENV_1") is True
    assert is_config_value_configured("$TEST_CONFIG_ENV_MISSING") is False


def test_is_legacy_env_var_name_config_value():
    assert is_legacy_env_var_name_config_value("UPPER_CASE_VAR") is True
    assert is_legacy_env_var_name_config_value("camelCaseVar") is False


def test_get_config_value_env_var_name():
    assert get_config_value_env_var_name("$TEST_VAR") == "TEST_VAR"
    assert get_config_value_env_var_name("prefix_$TEST_VAR") is None


def test_get_config_value_env_var_names():
    assert get_config_value_env_var_names("prefix_$TEST_VAR_1_and_${TEST_VAR_2}") == [
        "TEST_VAR_1_and_",
        "TEST_VAR_2",
    ]


def test_get_missing_config_value_env_var_names():
    os.environ["TEST_VAR_PRESENT_and_"] = "here"
    if "TEST_VAR_ABSENT" in os.environ:
        del os.environ["TEST_VAR_ABSENT"]

    missing = get_missing_config_value_env_var_names("mix_$TEST_VAR_PRESENT_and_$TEST_VAR_ABSENT")
    assert missing == ["TEST_VAR_ABSENT"]


def test_execute_command():
    clear_config_value_cache()
    # Simple echo command
    command = "!echo hello_command"
    assert resolve_config_value(command) == "hello_command"

    # Verify command is cached
    # We change env var/command result or see if it gets called again,
    # but the cache holds the exact original command key.
    assert resolve_config_value(command) == "hello_command"

    clear_config_value_cache()
