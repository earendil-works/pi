import os
import re
import sys
import subprocess
from typing import Literal, TypedDict, Union

# Cache for shell command results (persists for process lifetime)
command_result_cache: dict[str, str | None] = {}

ENV_VAR_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENV_VAR_NAME_PREFIX_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*")
LEGACY_ENV_VAR_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")


class LiteralPart(TypedDict):
    type: Literal["literal"]
    value: str


class EnvPart(TypedDict):
    type: Literal["env"]
    name: str


TemplatePart = Union[LiteralPart, EnvPart]


class CommandConfig(TypedDict):
    type: Literal["command"]
    config: str


class TemplateConfig(TypedDict):
    type: Literal["template"]
    parts: list[TemplatePart]


ConfigValueReference = Union[CommandConfig, TemplateConfig]


def append_literal(parts: list[TemplatePart], value: str) -> None:
    if not value:
        return
    if parts and parts[-1]["type"] == "literal":
        # Safe update since parts[-1] is verified to be LiteralPart
        parts[-1]["value"] += value  # type: ignore
        return
    parts.append({"type": "literal", "value": value})


def parse_config_value_template(config: str) -> list[TemplatePart]:
    parts: list[TemplatePart] = []
    index = 0
    length = len(config)

    while index < length:
        dollar_index = config.find("$", index)
        if dollar_index < 0:
            append_literal(parts, config[index:])
            break

        append_literal(parts, config[index:dollar_index])

        if dollar_index + 1 >= length:
            append_literal(parts, "$")
            index = dollar_index + 1
            continue

        next_char = config[dollar_index + 1]

        if next_char in ("$", "!"):
            append_literal(parts, next_char)
            index = dollar_index + 2
            continue

        if next_char == "{":
            end_index = config.find("}", dollar_index + 2)
            if end_index < 0:
                append_literal(parts, "$")
                index = dollar_index + 1
                continue

            name = config[dollar_index + 2 : end_index]
            if ENV_VAR_NAME_RE.match(name):
                parts.append({"type": "env", "name": name})
            else:
                append_literal(parts, config[dollar_index : end_index + 1])
            index = end_index + 1
            continue

        match = ENV_VAR_NAME_PREFIX_RE.match(config[dollar_index + 1 :])
        if match:
            var_name = match.group(0)
            parts.append({"type": "env", "name": var_name})
            index = dollar_index + 1 + len(var_name)
            continue

        append_literal(parts, "$")
        index = dollar_index + 1

    return parts


def parse_config_value_reference(config: str) -> ConfigValueReference:
    if config.startswith("!"):
        return {"type": "command", "config": config}
    return {"type": "template", "parts": parse_config_value_template(config)}


def resolve_env_config_value(name: str, env: dict[str, str] | None = None) -> str | None:
    if env and name in env:
        return env[name]
    return os.environ.get(name)


def get_template_env_var_names(parts: list[TemplatePart]) -> list[str]:
    names: list[str] = []
    for part in parts:
        if part["type"] == "env" and part["name"] not in names:
            names.append(part["name"])
    return names


def resolve_template(parts: list[TemplatePart], env: dict[str, str] | None = None) -> str | None:
    resolved = []
    for part in parts:
        if part["type"] == "literal":
            resolved.append(part["value"])
        elif part["type"] == "env":
            val = resolve_env_config_value(part["name"], env)
            if val is None:
                return None
            resolved.append(val)
    return "".join(resolved)


def get_config_value_env_var_name(config: str) -> str | None:
    ref = parse_config_value_reference(config)
    if ref["type"] != "template":
        return None
    parts = ref["parts"]
    if len(parts) == 1 and parts[0]["type"] == "env":
        return parts[0]["name"]
    return None


def get_config_value_env_var_names(config: str) -> list[str]:
    ref = parse_config_value_reference(config)
    if ref["type"] == "template":
        return get_template_env_var_names(ref["parts"])
    return []


def get_missing_config_value_env_var_names(
    config: str, env: dict[str, str] | None = None
) -> list[str]:
    return [
        name
        for name in get_config_value_env_var_names(config)
        if resolve_env_config_value(name, env) is None
    ]


def is_config_value_configured(config: str, env: dict[str, str] | None = None) -> bool:
    return len(get_missing_config_value_env_var_names(config, env)) == 0


def is_legacy_env_var_name_config_value(config: str) -> bool:
    return bool(LEGACY_ENV_VAR_NAME_RE.match(config))


def execute_with_configured_shell(command: str) -> tuple[bool, str | None]:
    try:
        from pi_mono.utils.shell import get_shell_config

        config = get_shell_config()
        shell = config["shell"]
        args = config["args"]
        result = subprocess.run(
            [shell] + args + [command],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return True, None
        return True, (result.stdout or "").strip() or None
    except Exception:
        return False, None


def execute_with_default_shell(command: str) -> str | None:
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        return (result.stdout or "").strip() or None
    except Exception:
        return None


def execute_command_uncached(command_config: str) -> str | None:
    command = command_config[1:]
    if sys.platform == "win32":
        executed, val = execute_with_configured_shell(command)
        if executed:
            return val
        return execute_with_default_shell(command)
    return execute_with_default_shell(command)


def execute_command(command_config: str) -> str | None:
    if command_config in command_result_cache:
        return command_result_cache[command_config]
    res = execute_command_uncached(command_config)
    command_result_cache[command_config] = res
    return res


def is_command_config_value(config: str) -> bool:
    return parse_config_value_reference(config)["type"] == "command"


def resolve_config_value(config: str, env: dict[str, str] | None = None) -> str | None:
    """Resolve a config value (API key, header value, etc.) to an actual value."""
    ref = parse_config_value_reference(config)
    if ref["type"] == "command":
        return execute_command(ref["config"])
    return resolve_template(ref["parts"], env)


def resolve_config_value_uncached(config: str, env: dict[str, str] | None = None) -> str | None:
    ref = parse_config_value_reference(config)
    if ref["type"] == "command":
        return execute_command_uncached(ref["config"])
    return resolve_template(ref["parts"], env)


def resolve_config_value_or_throw(
    config: str, description: str, env: dict[str, str] | None = None
) -> str:
    resolved = resolve_config_value_uncached(config, env)
    if resolved is not None:
        return resolved

    ref = parse_config_value_reference(config)
    if ref["type"] == "command":
        raise ValueError(f"Failed to resolve {description} from shell command: {ref['config'][1:]}")

    if ref["type"] == "template":
        missing = get_missing_config_value_env_var_names(config, env)
        if len(missing) == 1:
            raise ValueError(
                f"Failed to resolve {description} from environment variable: {missing[0]}"
            )
        if len(missing) > 1:
            raise ValueError(
                f"Failed to resolve {description} from environment variables: {', '.join(missing)}"
            )

    raise ValueError(f"Failed to resolve {description}")


def resolve_headers(
    headers: dict[str, str] | None, env: dict[str, str] | None = None
) -> dict[str, str] | None:
    """Resolve all header values using the same resolution logic as API keys."""
    if not headers:
        return None
    resolved = {}
    for k, v in headers.items():
        res_val = resolve_config_value(v, env)
        if res_val:
            resolved[k] = res_val
    return resolved if resolved else None


def resolve_headers_or_throw(
    headers: dict[str, str] | None, description: str, env: dict[str, str] | None = None
) -> dict[str, str] | None:
    if not headers:
        return None
    resolved = {}
    for k, v in headers.items():
        resolved[k] = resolve_config_value_or_throw(v, f'{description} header "{k}"', env)
    return resolved if resolved else None


def clear_config_value_cache() -> None:
    """Clear the config value command cache."""
    command_result_cache.clear()
