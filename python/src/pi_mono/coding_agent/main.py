"""Main entry point for the coding agent CLI."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any

from pi_mono.config import VERSION, get_agent_dir, get_package_dir
from pi_mono.coding_agent.cli.args import Args, parse_args, print_help
from pi_mono.coding_agent.cli.file_processor import process_file_arguments
from pi_mono.coding_agent.cli.initial_message import InitialMessageInput, build_initial_message
from pi_mono.coding_agent.cli.list_models import list_models
from pi_mono.coding_agent.cli.session_picker import select_session
from pi_mono.coding_agent.cli.project_trust import (
    bootstrap_project_trusted,
    should_prompt_project_trust_in_interactive,
)
from pi_mono.utils.windows_self_update import cleanup_windows_self_update_quarantine
from pi_mono.core.http_dispatcher import apply_http_proxy_settings
from pi_mono.coding_agent.core.model_resolver import resolve_cli_model, resolve_model_scope
from pi_mono.coding_agent.migrations import run_migrations, show_deprecation_warnings
from pi_mono.coding_agent.core.output_guard import restore_stdout, take_over_stdout
from pi_mono.coding_agent.core.export_html import export_from_file
from pi_mono.coding_agent.core.sdk import create_agent_session_runtime
from pi_mono.coding_agent.modes.interactive.interactive_mode import (
    InteractiveModeOptions,
    run_interactive_mode,
)
from pi_mono.coding_agent.modes.print_mode import PrintModeOptions, run_print_mode
from pi_mono.coding_agent.modes.rpc.rpc_mode import run_rpc_mode
from pi_mono.coding_agent.package_manager_cli import handle_config_command, handle_package_command
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry
from pi_mono.core.session_manager import (
    SessionManager,
    assert_valid_session_id,
    get_default_session_dir,
)
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.utils.paths import is_local_path, resolve_path


@dataclass
class MainOptions:
    extension_factories: list[Any] | None = None


def _is_truthy_env_flag(value: str | None) -> bool:
    if not value:
        return False
    return value.lower() in ("1", "true", "yes")


def _resolve_app_mode(parsed: Args, stdin_is_tty: bool) -> str:
    if parsed.mode == "rpc":
        return "rpc"
    if parsed.mode == "json":
        return "json"
    if parsed.print_mode or not stdin_is_tty:
        return "print"
    return "interactive"


def _to_print_output_mode(app_mode: str) -> str:
    return "json" if app_mode == "json" else "text"


def _report_diagnostics(diagnostics: list[dict[str, str]]) -> None:
    for diagnostic in diagnostics:
        prefix = "Error" if diagnostic["type"] == "error" else "Warning"
        print(f"{prefix}: {diagnostic['message']}", file=sys.stderr)


def _resolve_cli_paths(cwd: str, paths: list[str] | None) -> list[str] | None:
    if not paths:
        return None
    return [resolve_path(path, cwd) if is_local_path(path) else path for path in paths]


async def _read_piped_stdin() -> str | None:
    if sys.stdin.isatty():
        return None
    try:
        import select

        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if not ready:
            return None
    except (ImportError, ValueError, OSError):
        return None
    data = sys.stdin.read()
    stripped = data.strip()
    return stripped if stripped else None


async def _prepare_initial_message(
    parsed: Args,
    *,
    cwd: str,
    stdin_content: str | None,
) -> tuple[str | None, list[Any] | None, list[str]]:
    """Return initial message, images, and remaining follow-up messages."""
    messages = list(parsed.messages)
    parsed_copy = Args(**{**parsed.__dict__, "messages": messages})

    if parsed.file_args:
        processed = await process_file_arguments(parsed.file_args, cwd=cwd)
        result = build_initial_message(
            InitialMessageInput(
                parsed=parsed_copy,
                file_text=processed.text or None,
                file_images=processed.images or None,
                stdin_content=stdin_content,
            )
        )
        return result.initial_message, result.initial_images, list(parsed_copy.messages)

    result = build_initial_message(
        InitialMessageInput(parsed=parsed_copy, stdin_content=stdin_content)
    )
    return result.initial_message, result.initial_images, list(parsed_copy.messages)


def _validate_fork_flags(parsed: Args) -> None:
    if not parsed.fork:
        return
    conflicting = [
        flag
        for flag, enabled in (
            ("--session", parsed.session),
            ("--continue", parsed.continue_session),
            ("--resume", parsed.resume),
            ("--no-session", parsed.no_session),
        )
        if enabled
    ]
    if conflicting:
        print(f"Error: --fork cannot be combined with {', '.join(conflicting)}", file=sys.stderr)
        raise SystemExit(1)


def _validate_session_id_flags(parsed: Args) -> None:
    if parsed.session_id is None:
        return
    conflicting = [
        flag
        for flag, enabled in (
            ("--session", parsed.session),
            ("--continue", parsed.continue_session),
            ("--resume", parsed.resume),
            ("--no-session", parsed.no_session),
        )
        if enabled
    ]
    if conflicting:
        print(
            f"Error: --session-id cannot be combined with {', '.join(conflicting)}", file=sys.stderr
        )
        raise SystemExit(1)
    try:
        assert_valid_session_id(parsed.session_id)
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from error


async def _find_local_session_by_exact_id(
    session_id: str,
    cwd: str,
    session_dir: str | None,
) -> dict[str, str] | None:
    local_sessions = await SessionManager.list(cwd, session_dir)
    local_match = next(
        (session for session in local_sessions if session.get("id") == session_id), None
    )
    if local_match:
        return {"type": "local", "path": str(local_match["path"])}
    return None


async def _resolve_session_path(
    session_arg: str,
    cwd: str,
    session_dir: str | None,
) -> dict[str, str]:
    if "/" in session_arg or "\\" in session_arg or session_arg.endswith(".jsonl"):
        return {"type": "path", "path": resolve_path(session_arg, cwd)}

    local_sessions = await SessionManager.list(cwd, session_dir)
    local_match = next(
        (
            session
            for session in local_sessions
            if session.get("id") == session_arg
            or str(session.get("id", "")).startswith(session_arg)
        ),
        None,
    )
    if local_match:
        return {"type": "local", "path": str(local_match["path"])}

    all_sessions = await SessionManager.list_all(session_dir)
    global_match = next(
        (
            session
            for session in all_sessions
            if session.get("id") == session_arg
            or str(session.get("id", "")).startswith(session_arg)
        ),
        None,
    )
    if global_match:
        return {
            "type": "global",
            "path": str(global_match["path"]),
            "cwd": str(global_match.get("cwd", "")),
        }

    return {"type": "not_found", "arg": session_arg}


def _fork_session_or_exit(
    source_path: str,
    cwd: str,
    session_dir: str | None,
    session_id: str | None = None,
) -> SessionManager:
    try:
        options = {"id": session_id} if session_id else None
        return SessionManager.fork_from(source_path, cwd, session_dir, options)
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from error


async def _create_session_manager(parsed: Args, cwd: str, agent_dir: str) -> SessionManager:
    settings = SettingsManager.create(cwd, agent_dir)
    session_dir = parsed.session_dir or settings.get_session_dir()
    session_dir = (
        resolve_path(session_dir, cwd) if session_dir else get_default_session_dir(cwd, agent_dir)
    )

    if parsed.no_session or parsed.help or parsed.list_models is not None:
        return SessionManager.in_memory(cwd)

    if parsed.fork:
        if parsed.session_id:
            existing_target = await _find_local_session_by_exact_id(
                parsed.session_id, cwd, session_dir
            )
            if existing_target:
                print(f"Session already exists with id '{parsed.session_id}'", file=sys.stderr)
                raise SystemExit(1)

        resolved = await _resolve_session_path(parsed.fork, cwd, session_dir)
        resolved_type = resolved["type"]
        if resolved_type in ("path", "local", "global"):
            return _fork_session_or_exit(resolved["path"], cwd, session_dir, parsed.session_id)
        print(f"No session found matching '{resolved['arg']}'", file=sys.stderr)
        raise SystemExit(1)

    if parsed.session:
        resolved = await _resolve_session_path(parsed.session, cwd, session_dir)
        resolved_type = resolved["type"]
        if resolved_type in ("path", "local"):
            return SessionManager.open(resolved["path"], session_dir)
        if resolved_type == "global":
            print(f"Session found in different project: {resolved['cwd']}", file=sys.stderr)
            print("Forking session into current directory.", file=sys.stderr)
            return _fork_session_or_exit(resolved["path"], cwd, session_dir)
        print(f"No session found matching '{resolved['arg']}'", file=sys.stderr)
        raise SystemExit(1)

    if parsed.resume:
        selected_path = await select_session(
            lambda on_progress=None: SessionManager.list(cwd, session_dir, on_progress),
            lambda on_progress=None: SessionManager.list_all(session_dir, on_progress),
        )
        if not selected_path:
            print("No session selected", file=sys.stderr)
            raise SystemExit(0)
        return SessionManager.open(selected_path, session_dir)

    if parsed.continue_session:
        return SessionManager.continue_recent(cwd, session_dir)

    if parsed.session_id:
        existing_session = await _find_local_session_by_exact_id(
            parsed.session_id, cwd, session_dir
        )
        if existing_session:
            return SessionManager.open(existing_session["path"], session_dir)

    return SessionManager.create(
        cwd, session_dir, {"id": parsed.session_id} if parsed.session_id else None
    )


def _resolve_project_trusted_for_runtime(
    parsed: Args, cwd: str, agent_dir: str, app_mode: str
) -> bool:
    if app_mode == "interactive" and should_prompt_project_trust_in_interactive(
        cwd=cwd,
        agent_dir=agent_dir,
        trust_override=parsed.project_trust_override,
        project_trusted=False,
    ):
        return False
    return bootstrap_project_trusted(
        cwd=cwd,
        agent_dir=agent_dir,
        trust_override=parsed.project_trust_override,
    )


async def _create_runtime(parsed: Args, cwd: str, agent_dir: str, app_mode: str) -> Any:
    no_tools: str | None = None
    if parsed.no_tools:
        no_tools = "all"
    elif parsed.no_builtin_tools:
        no_tools = "builtin"

    resource_loader_options: dict[str, object] = {}
    if parsed.system_prompt:
        resource_loader_options["system_prompt"] = parsed.system_prompt
    if parsed.append_system_prompt:
        resource_loader_options["append_system_prompt"] = parsed.append_system_prompt
    if parsed.no_skills:
        resource_loader_options["no_skills"] = True
    if parsed.no_prompt_templates:
        resource_loader_options["no_prompt_templates"] = True
    if parsed.no_context_files:
        resource_loader_options["no_context_files"] = True
    skills = _resolve_cli_paths(cwd, parsed.skills)
    if skills:
        resource_loader_options["additional_skill_paths"] = skills
    prompt_templates = _resolve_cli_paths(cwd, parsed.prompt_templates)
    if prompt_templates:
        resource_loader_options["additional_prompt_template_paths"] = prompt_templates
    auth_storage = AuthStorage.create(os.path.join(agent_dir, "auth.json"))
    model_registry = ModelRegistry.create(auth_storage, os.path.join(agent_dir, "models.json"))

    if parsed.api_key and parsed.provider:
        auth_storage.set_runtime_api_key(parsed.provider, parsed.api_key)

    model = None
    thinking_level = parsed.thinking
    scoped_models = resolve_model_scope(parsed.models, model_registry) if parsed.models else []

    if parsed.provider and parsed.provider.lower() == "faux":
        from pi_mono.ai.providers.faux import (
            DEFAULT_MODEL_ID,
            faux_assistant_message,
            register_faux_provider,
        )

        faux = register_faux_provider({"provider": "faux", "api": "faux"})
        faux.set_responses([faux_assistant_message("ok")])
        auth_storage.set_runtime_api_key("faux", "local")
        model = faux.get_model(parsed.model or DEFAULT_MODEL_ID)
        if model is None:
            print("Error: Unknown faux model. Use --model faux-1.", file=sys.stderr)
            raise SystemExit(1)
    else:
        resolved = resolve_cli_model(
            cli_provider=parsed.provider,
            cli_model=parsed.model,
            model_registry=model_registry,
        )
        if resolved.error:
            print(f"Error: {resolved.error}", file=sys.stderr)
            raise SystemExit(1)
        if resolved.warning:
            print(f"Warning: {resolved.warning}", file=sys.stderr)
        if resolved.model:
            model = resolved.model
            if resolved.thinking_level and thinking_level is None:
                thinking_level = resolved.thinking_level

    _validate_fork_flags(parsed)
    _validate_session_id_flags(parsed)
    session_manager = await _create_session_manager(parsed, cwd, agent_dir)
    if parsed.name is not None:
        name = parsed.name.strip()
        if not name:
            print("Error: --name requires a non-empty value", file=sys.stderr)
            raise SystemExit(1)
        session_manager.append_session_info(name)

    project_trusted = _resolve_project_trusted_for_runtime(parsed, cwd, agent_dir, app_mode)
    settings_manager = SettingsManager.create(cwd, agent_dir, project_trusted=project_trusted)
    apply_http_proxy_settings(settings_manager.get_http_proxy())

    runtime = await create_agent_session_runtime(
        cwd=cwd,
        agent_dir=agent_dir,
        session_manager=session_manager,
        model=model,
        thinking_level=thinking_level,
        scoped_models=scoped_models or None,
        tools=parsed.tools,
        exclude_tools=parsed.exclude_tools,
        no_tools=no_tools,
        resource_loader_options=resource_loader_options or None,
        extension_flag_values=parsed.unknown_flags or None,
        no_extensions=parsed.no_extensions,
        settings_manager=settings_manager,
        auth_storage=auth_storage,
        model_registry=model_registry,
    )
    if runtime.diagnostics:
        _report_diagnostics(runtime.diagnostics)
        if any(item["type"] == "error" for item in runtime.diagnostics):
            raise SystemExit(1)
    if runtime.model_fallback_message:
        print(f"Warning: {runtime.model_fallback_message}", file=sys.stderr)
    return runtime


async def main(args: list[str] | None = None, options: MainOptions | None = None) -> None:
    del options  # extension factories wired via resource loader
    argv = list(args if args is not None else sys.argv[1:])
    if argv and argv[0] in ("install", "remove", "list", "update", "uninstall"):
        handled = await handle_package_command(argv)
        if handled:
            return

    if argv and argv[0] == "config":
        handled = await handle_config_command(argv)
        if handled:
            return

    offline_mode = "--offline" in argv or _is_truthy_env_flag(os.environ.get("PI_OFFLINE"))
    if offline_mode:
        os.environ["PI_OFFLINE"] = "1"
        os.environ["PI_SKIP_VERSION_CHECK"] = "1"

    if sys.platform == "win32":
        cleanup_windows_self_update_quarantine(str(get_package_dir()))

    parsed = parse_args(argv)
    if parsed.diagnostics:
        _report_diagnostics(parsed.diagnostics)
        if any(item["type"] == "error" for item in parsed.diagnostics):
            raise SystemExit(1)

    app_mode = _resolve_app_mode(parsed, sys.stdin.isatty())
    should_take_over_stdout = app_mode != "interactive"
    if should_take_over_stdout:
        take_over_stdout()

    if parsed.version:
        print(VERSION)
        return

    if parsed.help:
        print_help()
        return

    if parsed.export:
        try:
            output_path = export_from_file(parsed.export)
            print(output_path)
        except (FileNotFoundError, ValueError) as error:
            print(f"Error: {error}", file=sys.stderr)
            raise SystemExit(1) from error
        return

    if parsed.list_models is not None:
        registry = ModelRegistry.create(AuthStorage.create())
        search_pattern = parsed.list_models if isinstance(parsed.list_models, str) else None
        list_models(registry, search_pattern)
        return

    if app_mode == "rpc" and parsed.file_args:
        print("Error: @file arguments are not supported in RPC mode", file=sys.stderr)
        raise SystemExit(1)

    cwd = os.getcwd()
    agent_dir = str(get_agent_dir())
    startup_settings = SettingsManager.create(cwd, agent_dir, project_trusted=False)
    apply_http_proxy_settings(startup_settings.get_http_proxy())
    migration_result = run_migrations(cwd)
    if app_mode == "interactive" and migration_result.deprecation_warnings:
        await show_deprecation_warnings(migration_result.deprecation_warnings)

    try:
        runtime = await _create_runtime(parsed, cwd, agent_dir, app_mode)
        stdin_content: str | None = None
        if app_mode != "rpc":
            stdin_content = await _read_piped_stdin()
        initial_message, initial_images, follow_up_messages = await _prepare_initial_message(
            parsed,
            cwd=cwd,
            stdin_content=stdin_content,
        )

        if app_mode == "interactive":
            from pi_mono.coding_agent.cli.startup_ui import (
                should_run_first_time_setup,
                show_first_time_setup,
            )

            if should_run_first_time_setup():
                setup_result = await show_first_time_setup(startup_settings)
                if setup_result is None:
                    return
            await run_interactive_mode(
                runtime,
                InteractiveModeOptions(
                    initial_message=initial_message,
                    initial_images=initial_images,
                    initial_messages=follow_up_messages or None,
                    verbose=parsed.verbose,
                ),
            )
            return

        if app_mode == "rpc":
            await run_rpc_mode(runtime)
            return

        exit_code = await run_print_mode(
            runtime,
            PrintModeOptions(
                mode=_to_print_output_mode(app_mode),  # type: ignore[arg-type]
                messages=follow_up_messages,
                initial_message=initial_message,
                initial_images=initial_images,
            ),
        )
        if exit_code != 0:
            raise SystemExit(exit_code)
    finally:
        if should_take_over_stdout:
            restore_stdout()
