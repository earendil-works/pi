"""CLI argument parsing and help display."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pi_mono.agent.types import ThinkingLevel
from pi_mono.config import APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR

Mode = Literal["text", "json", "rpc"]

VALID_THINKING_LEVELS: tuple[ThinkingLevel, ...] = (
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)


@dataclass
class Args:
    provider: str | None = None
    model: str | None = None
    api_key: str | None = None
    system_prompt: str | None = None
    append_system_prompt: list[str] | None = None
    thinking: ThinkingLevel | None = None
    continue_session: bool = False
    resume: bool = False
    help: bool = False
    version: bool = False
    mode: Mode | None = None
    name: str | None = None
    no_session: bool = False
    session: str | None = None
    session_id: str | None = None
    fork: str | None = None
    session_dir: str | None = None
    models: list[str] | None = None
    tools: list[str] | None = None
    exclude_tools: list[str] | None = None
    no_tools: bool = False
    no_builtin_tools: bool = False
    extensions: list[str] | None = None
    no_extensions: bool = False
    print_mode: bool = False
    export: str | None = None
    no_skills: bool = False
    skills: list[str] | None = None
    prompt_templates: list[str] | None = None
    no_prompt_templates: bool = False
    themes: list[str] | None = None
    no_themes: bool = False
    no_context_files: bool = False
    list_models: str | bool | None = None
    offline: bool = False
    verbose: bool = False
    project_trust_override: bool | None = None
    messages: list[str] = field(default_factory=list)
    file_args: list[str] = field(default_factory=list)
    unknown_flags: dict[str, bool | str] = field(default_factory=dict)
    diagnostics: list[dict[str, str]] = field(default_factory=list)


def is_valid_thinking_level(level: str) -> bool:
    return level in VALID_THINKING_LEVELS


def parse_args(args: list[str]) -> Args:
    result = Args()

    i = 0
    while i < len(args):
        arg = args[i]

        if arg in ("--help", "-h"):
            result.help = True
        elif arg in ("--version", "-v"):
            result.version = True
        elif arg == "--mode" and i + 1 < len(args):
            mode = args[i + 1]
            i += 1
            if mode in ("text", "json", "rpc"):
                result.mode = mode  # type: ignore[assignment]
        elif arg in ("--continue", "-c"):
            result.continue_session = True
        elif arg in ("--resume", "-r"):
            result.resume = True
        elif arg == "--provider" and i + 1 < len(args):
            result.provider = args[i + 1]
            i += 1
        elif arg == "--model" and i + 1 < len(args):
            result.model = args[i + 1]
            i += 1
        elif arg == "--api-key" and i + 1 < len(args):
            result.api_key = args[i + 1]
            i += 1
        elif arg == "--system-prompt" and i + 1 < len(args):
            result.system_prompt = args[i + 1]
            i += 1
        elif arg == "--append-system-prompt" and i + 1 < len(args):
            if result.append_system_prompt is None:
                result.append_system_prompt = []
            result.append_system_prompt.append(args[i + 1])
            i += 1
        elif arg in ("--name", "-n"):
            if i + 1 < len(args):
                result.name = args[i + 1]
                i += 1
            else:
                result.diagnostics.append({"type": "error", "message": "--name requires a value"})
        elif arg == "--no-session":
            result.no_session = True
        elif arg == "--session" and i + 1 < len(args):
            result.session = args[i + 1]
            i += 1
        elif arg == "--session-id" and i + 1 < len(args):
            result.session_id = args[i + 1]
            i += 1
        elif arg == "--fork" and i + 1 < len(args):
            result.fork = args[i + 1]
            i += 1
        elif arg == "--session-dir" and i + 1 < len(args):
            result.session_dir = args[i + 1]
            i += 1
        elif arg == "--models" and i + 1 < len(args):
            result.models = [s.strip() for s in args[i + 1].split(",")]
            i += 1
        elif arg in ("--no-tools", "-nt"):
            result.no_tools = True
        elif arg in ("--no-builtin-tools", "-nbt"):
            result.no_builtin_tools = True
        elif arg in ("--tools", "-t") and i + 1 < len(args):
            result.tools = [s.strip() for s in args[i + 1].split(",") if s.strip()]
            i += 1
        elif arg in ("--exclude-tools", "-xt") and i + 1 < len(args):
            result.exclude_tools = [s.strip() for s in args[i + 1].split(",") if s.strip()]
            i += 1
        elif arg == "--thinking" and i + 1 < len(args):
            level = args[i + 1]
            i += 1
            if is_valid_thinking_level(level):
                result.thinking = level  # type: ignore[assignment]
            else:
                result.diagnostics.append(
                    {
                        "type": "warning",
                        "message": (
                            f'Invalid thinking level "{level}". '
                            f"Valid values: {', '.join(VALID_THINKING_LEVELS)}"
                        ),
                    }
                )
        elif arg in ("--print", "-p"):
            result.print_mode = True
            if i + 1 < len(args):
                next_arg = args[i + 1]
                if not next_arg.startswith("@") and (
                    not next_arg.startswith("-") or next_arg.startswith("---")
                ):
                    result.messages.append(next_arg)
                    i += 1
        elif arg == "--export" and i + 1 < len(args):
            result.export = args[i + 1]
            i += 1
        elif arg in ("--extension", "-e") and i + 1 < len(args):
            if result.extensions is None:
                result.extensions = []
            result.extensions.append(args[i + 1])
            i += 1
        elif arg in ("--no-extensions", "-ne"):
            result.no_extensions = True
        elif arg == "--skill" and i + 1 < len(args):
            if result.skills is None:
                result.skills = []
            result.skills.append(args[i + 1])
            i += 1
        elif arg == "--prompt-template" and i + 1 < len(args):
            if result.prompt_templates is None:
                result.prompt_templates = []
            result.prompt_templates.append(args[i + 1])
            i += 1
        elif arg == "--theme" and i + 1 < len(args):
            if result.themes is None:
                result.themes = []
            result.themes.append(args[i + 1])
            i += 1
        elif arg in ("--no-skills", "-ns"):
            result.no_skills = True
        elif arg in ("--no-prompt-templates", "-np"):
            result.no_prompt_templates = True
        elif arg == "--no-themes":
            result.no_themes = True
        elif arg in ("--no-context-files", "-nc"):
            result.no_context_files = True
        elif arg == "--list-models":
            if (
                i + 1 < len(args)
                and not args[i + 1].startswith("-")
                and not args[i + 1].startswith("@")
            ):
                result.list_models = args[i + 1]
                i += 1
            else:
                result.list_models = True
        elif arg == "--verbose":
            result.verbose = True
        elif arg == "--offline":
            result.offline = True
        elif arg in ("--approve", "-a"):
            result.project_trust_override = True
        elif arg in ("--no-approve", "-na"):
            result.project_trust_override = False
        elif arg.startswith("@"):
            result.file_args.append(arg[1:])
        elif arg.startswith("--"):
            eq_index = arg.find("=")
            if eq_index != -1:
                result.unknown_flags[arg[2:eq_index]] = arg[eq_index + 1 :]
            else:
                flag_name = arg[2:]
                if (
                    i + 1 < len(args)
                    and not args[i + 1].startswith("-")
                    and not args[i + 1].startswith("@")
                ):
                    result.unknown_flags[flag_name] = args[i + 1]
                    i += 1
                else:
                    result.unknown_flags[flag_name] = True
        elif arg.startswith("-") and not arg.startswith("--"):
            result.diagnostics.append({"type": "error", "message": f"Unknown option: {arg}"})
        elif not arg.startswith("-"):
            result.messages.append(arg)

        i += 1

    return result


def print_help(extension_flags: list[dict[str, str]] | None = None) -> None:
    extension_flags_text = ""
    if extension_flags:
        lines = []
        for flag in extension_flags:
            value = " <value>" if flag.get("type") == "string" else ""
            description = (
                flag.get("description") or f"Registered by {flag.get('extensionPath', 'extension')}"
            )
            lines.append(f"  --{flag['name']}{value}".ljust(30) + description)
        extension_flags_text = "\nExtension CLI Flags:\n" + "\n".join(lines) + "\n"

    print(
        f"""{APP_NAME} - AI coding assistant with read, bash, edit, write tools

Usage:
  {APP_NAME} [options] [@files...] [messages...]

Options:
  --provider <name>              Provider name
  --model <pattern>              Model pattern or ID
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt
  --append-system-prompt <text>  Append to system prompt (repeatable)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --session-id <id>              Use exact project session ID
  --fork <path|id>               Fork session into a new session
  --session-dir <dir>            Directory for session storage
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --models <patterns>            Comma-separated model patterns
  --no-tools, -nt                Disable all tools
  --no-builtin-tools, -nbt       Disable built-in tools only
  --tools, -t <tools>            Comma-separated tool allowlist
  --exclude-tools, -xt <tools>   Comma-separated tool denylist
  --thinking <level>             Thinking level: off, minimal, low, medium, high, xhigh, max
  --list-models [search]         List available models
  --verbose                      Force verbose startup
  --offline                      Disable startup network operations
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags.{extension_flags_text}

Environment Variables:
  {ENV_AGENT_DIR:<32} - Config directory (default: ~/{CONFIG_DIR_NAME}/agent)
  {ENV_SESSION_DIR:<32} - Session storage directory
  PI_OFFLINE                       - Disable startup network operations

Built-in Tool Names:
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
"""
    )
