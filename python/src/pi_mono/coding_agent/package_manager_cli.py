"""Package manager CLI commands (install/remove/list/update).

Ported from packages/coding-agent/src/package-manager-cli.ts (local-path subset).
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Literal

from pi_mono.config import (
    APP_NAME,
    PACKAGE_NAME,
    VERSION,
    detect_install_method,
    get_agent_dir,
    get_package_dir,
    get_self_update_command,
    get_self_update_unavailable_instruction,
)
from pi_mono.coding_agent.cli.project_trust import bootstrap_project_trusted
from pi_mono.coding_agent.core.package_manager import DefaultPackageManager
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.utils.version_check import get_latest_pi_release, is_newer_package_version
from pi_mono.utils.windows_self_update import (
    cleanup_windows_self_update_quarantine,
    quarantine_windows_native_dependencies,
)

CONFIG_COMMAND_USAGE = f"{APP_NAME} config [-l] [--approve|--no-approve]"

PackageCommand = Literal["install", "remove", "update", "list"]
UpdateTargetType = Literal["all", "self", "extensions"]


@dataclass
class UpdateTarget:
    type: UpdateTargetType
    source: str | None = None


@dataclass
class PackageCommandOptions:
    command: PackageCommand
    source: str | None = None
    update_target: UpdateTarget | None = None
    show_extensions_skipped_note: bool = False
    local: bool = False
    force: bool = False
    help: bool = False
    invalid_option: str | None = None
    invalid_argument: str | None = None
    missing_option_value: str | None = None
    conflicting_options: str | None = None


def _get_package_command_usage(command: PackageCommand) -> str:
    if command == "install":
        return f"{APP_NAME} install <source> [-l]"
    if command == "remove":
        return f"{APP_NAME} remove <source> [-l]"
    if command == "update":
        return f"{APP_NAME} update [source|self|pi] [--self|--extensions|--all] [--extension <source>] [--force]"
    return f"{APP_NAME} list"


def _print_package_command_help(command: PackageCommand) -> None:
    if command == "install":
        print(
            f"""Usage:
  {_get_package_command_usage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  {APP_NAME} install ./local/path
  {APP_NAME} install file:///path/to/package
  {APP_NAME} install npm:@scope/pkg
  {APP_NAME} install github.com/org/repo
"""
        )
        return

    if command == "remove":
        print(
            f"""Usage:
  {_get_package_command_usage("remove")}

Remove a package and its source from settings.
Alias: {APP_NAME} uninstall <source> [-l]

Options:
  -l, --local    Remove from project settings (.pi/settings.json)
"""
        )
        return

    if command == "update":
        print(
            f"""Usage:
  {_get_package_command_usage("update")}

Update pi and/or installed npm/git packages.

Options:
  --self                  Update pi only (default when no target is given)
  --extensions            Update installed packages only
  --all                   Update pi and installed packages
  --extension <source>    Update a specific package source
  --force                 Force self-update even if already on latest version

Examples:
  {APP_NAME} update
  {APP_NAME} update --extensions
  {APP_NAME} update --all
"""
        )
        return

    print(
        f"""Usage:
  {_get_package_command_usage("list")}

List installed packages from user and project settings.
"""
    )


def parse_package_command(args: list[str]) -> PackageCommandOptions | None:
    if not args:
        return None

    raw_command = args[0]
    if raw_command == "uninstall":
        command: PackageCommand | None = "remove"
    elif raw_command in ("install", "remove", "update", "list"):
        command = raw_command  # type: ignore[assignment]
    else:
        return None

    rest = args[1:]
    local = False
    force = False
    help_requested = False
    invalid_option: str | None = None
    invalid_argument: str | None = None
    missing_option_value: str | None = None
    conflicting_options: str | None = None
    source: str | None = None
    update_target: UpdateTarget | None = None
    show_extensions_skipped_note = False
    self_flag = False
    extensions_flag = False
    all_flag = False
    extension_flag_source: str | None = None

    index = 0
    while index < len(rest):
        arg = rest[index]
        if arg in ("-h", "--help"):
            help_requested = True
            index += 1
            continue

        if arg in ("-l", "--local"):
            if command in ("install", "remove"):
                local = True
            else:
                invalid_option = invalid_option or arg
            index += 1
            continue

        if command == "update":
            if arg == "--force":
                force = True
                index += 1
                continue
            if arg == "--self":
                self_flag = True
                index += 1
                continue
            if arg == "--extensions":
                extensions_flag = True
                index += 1
                continue
            if arg == "--all":
                all_flag = True
                index += 1
                continue
            if arg == "--extension":
                if index + 1 >= len(rest):
                    missing_option_value = missing_option_value or arg
                    index += 1
                    continue
                extension_flag_source = rest[index + 1]
                index += 2
                continue
            if arg in ("self", "pi"):
                source = arg
                index += 1
                continue

        if arg.startswith("-"):
            invalid_option = invalid_option or arg
            index += 1
            continue

        if source is None:
            source = arg
        else:
            invalid_argument = invalid_argument or arg
        index += 1

    if command == "update":
        if all_flag and (self_flag or extensions_flag or extension_flag_source or source):
            conflicting_options = (
                conflicting_options or "--all cannot be combined with other update targets"
            )
        if extension_flag_source and (self_flag or extensions_flag or all_flag):
            conflicting_options = (
                conflicting_options
                or "--extension cannot be combined with --self, --extensions, or --all"
            )
        if source and source not in ("self", "pi") and (self_flag or extensions_flag or all_flag):
            conflicting_options = (
                conflicting_options
                or "positional update targets cannot be combined with --self, --extensions, or --all"
            )
        if extension_flag_source:
            update_target = UpdateTarget(type="extensions", source=extension_flag_source)
        elif source == "self" or source == "pi":
            update_target = UpdateTarget(type="self")
        elif source:
            update_target = UpdateTarget(type="extensions", source=source)
        elif all_flag:
            update_target = UpdateTarget(type="all")
        elif extensions_flag:
            update_target = UpdateTarget(type="extensions")
        elif self_flag:
            update_target = UpdateTarget(type="self")
        else:
            update_target = UpdateTarget(type="self")
            show_extensions_skipped_note = True

    return PackageCommandOptions(
        command=command,
        source=source,
        update_target=update_target,
        show_extensions_skipped_note=show_extensions_skipped_note,
        local=local,
        force=force,
        help=help_requested,
        invalid_option=invalid_option,
        invalid_argument=invalid_argument,
        missing_option_value=missing_option_value,
        conflicting_options=conflicting_options,
    )


def _update_target_includes_self(target: UpdateTarget) -> bool:
    return target.type in ("all", "self")


def _update_target_includes_extensions(target: UpdateTarget) -> bool:
    return target.type in ("all", "extensions")


def _prepare_windows_npm_self_update() -> None:
    if sys.platform != "win32":
        return
    package_dir = str(get_package_dir())
    cleanup_windows_self_update_quarantine(package_dir)
    quarantine_windows_native_dependencies(package_dir)


async def _get_self_update_plan(force: bool) -> dict[str, Any]:
    if force:
        return {"packageName": PACKAGE_NAME, "shouldRun": True}
    try:
        latest_release = await get_latest_pi_release(VERSION)
        package_name = (
            latest_release.get("packageName", PACKAGE_NAME) if latest_release else PACKAGE_NAME
        )
        if (
            not latest_release
            or package_name != PACKAGE_NAME
            or is_newer_package_version(latest_release["version"], VERSION)
        ):
            plan: dict[str, Any] = {"packageName": package_name, "shouldRun": True}
            if latest_release and latest_release.get("note"):
                plan["note"] = latest_release["note"]
            return plan
    except Exception as error:
        print(
            f"Warning: could not check for updates ({error}). Skipping self-update.",
            file=sys.stderr,
        )
        return {"packageName": PACKAGE_NAME, "shouldRun": False}
    print(f"{APP_NAME} is already up to date (v{VERSION})")
    return {"packageName": PACKAGE_NAME, "shouldRun": False}


def _run_self_update(command: dict[str, Any]) -> None:
    print(f"Updating {APP_NAME} with {command.get('display', command.get('command', ''))}...")
    steps = command.get("steps") or [command]
    for step in steps:
        args = list(step.get("args", []))
        completed = subprocess.run([step["command"], *args], check=False)
        if completed.returncode != 0:
            raise RuntimeError(
                f"{step.get('display', step['command'])} exited with code {completed.returncode}"
            )


def _report_settings_errors(settings_manager: SettingsManager, context: str) -> None:
    for entry in settings_manager.drain_errors():
        scope = entry.get("scope", "unknown")
        error = entry.get("error")
        message = str(error)
        print(f"Warning ({context}, {scope} settings): {message}", file=sys.stderr)
        stack = getattr(error, "__traceback__", None)
        if stack is not None and hasattr(error, "__class__"):
            import traceback

            print(traceback.format_exc(), file=sys.stderr)


def _print_config_command_help() -> None:
    print(
        f"""{CONFIG_COMMAND_USAGE}

Open the interactive resource config UI.

Without -l, starts in global settings.
Press Tab in the TUI to switch between global and project-local modes.

Options:
  -l, --local       Edit project overrides
  -a, --approve     Trust project-local files for this command with -l
  -na, --no-approve Ignore project-local files for this command with -l
"""
    )


async def handle_config_command(args: list[str]) -> bool:
    if not args or args[0] != "config":
        return False

    rest = args[1:]
    if "-h" in rest or "--help" in rest:
        _print_config_command_help()
        return True

    local = False
    project_trust_override: bool | None = None
    for arg in rest:
        if arg in ("-l", "--local"):
            local = True
        elif arg in ("-a", "--approve"):
            project_trust_override = True
        elif arg in ("-na", "--no-approve"):
            project_trust_override = False
        elif arg.startswith("-"):
            print(f'Unknown option {arg} for "config".', file=sys.stderr)
            print(f'Use "{APP_NAME} --help" or "{CONFIG_COMMAND_USAGE}".', file=sys.stderr)
            sys.exit(1)
        else:
            print(f"Unexpected argument {arg}.", file=sys.stderr)
            print(f"Usage: {CONFIG_COMMAND_USAGE}", file=sys.stderr)
            sys.exit(1)

    cwd = os.getcwd()
    agent_dir = str(get_agent_dir())
    project_trusted = bootstrap_project_trusted(
        cwd=cwd,
        agent_dir=agent_dir,
        trust_override=project_trust_override,
    )
    if local and not project_trusted:
        print(
            "Project is not trusted. Use --approve to modify local resource config.",
            file=sys.stderr,
        )
        sys.exit(1)

    settings_manager = SettingsManager.create(cwd, agent_dir, project_trusted=project_trusted)
    _report_settings_errors(settings_manager, "config command")
    global_settings = SettingsManager.create(cwd, agent_dir, project_trusted=False)
    global_resolved = await DefaultPackageManager(
        cwd=cwd, agent_dir=agent_dir, settings_manager=global_settings
    ).resolve()
    project_resolved = (
        await DefaultPackageManager(
            cwd=cwd, agent_dir=agent_dir, settings_manager=settings_manager
        ).resolve()
        if settings_manager.is_project_trusted()
        else global_resolved
    )

    from pi_mono.coding_agent.cli.config_selector import select_config

    await select_config(
        cwd=cwd,
        agent_dir=agent_dir,
        settings_manager=settings_manager,
        resolved_paths={"global": global_resolved, "project": project_resolved},
        write_scope="project" if local else "global",
        project_mode_available=settings_manager.is_project_trusted(),
    )
    raise SystemExit(0)


async def handle_package_command(args: list[str]) -> bool:
    options = parse_package_command(args)
    if options is None:
        return False

    if options.help:
        _print_package_command_help(options.command)
        return True

    if options.invalid_option:
        print(f'Unknown option {options.invalid_option} for "{options.command}".', file=sys.stderr)
        print(
            f'Use "{APP_NAME} --help" or "{_get_package_command_usage(options.command)}".',
            file=sys.stderr,
        )
        sys.exit(1)

    if options.missing_option_value:
        print(f"Missing value for {options.missing_option_value}.", file=sys.stderr)
        print(f"Usage: {_get_package_command_usage(options.command)}", file=sys.stderr)
        sys.exit(1)

    if options.invalid_argument:
        print(f"Unexpected argument {options.invalid_argument}.", file=sys.stderr)
        print(f"Usage: {_get_package_command_usage(options.command)}", file=sys.stderr)
        sys.exit(1)

    if options.conflicting_options:
        print(options.conflicting_options, file=sys.stderr)
        print(f"Usage: {_get_package_command_usage(options.command)}", file=sys.stderr)
        sys.exit(1)

    if options.command in ("install", "remove") and not options.source:
        print(f"Missing {options.command} source.", file=sys.stderr)
        print(f"Usage: {_get_package_command_usage(options.command)}", file=sys.stderr)
        sys.exit(1)

    cwd = os.getcwd()
    agent_dir = str(get_agent_dir())
    settings_manager = SettingsManager.create(cwd, agent_dir)
    _report_settings_errors(settings_manager, "package command")
    package_manager = DefaultPackageManager(
        cwd=cwd, agent_dir=agent_dir, settings_manager=settings_manager
    )

    package_manager.set_progress_callback(
        lambda event: (
            print(event.get("message", ""), file=sys.stderr)
            if event.get("type") == "start"
            else None
        )
    )

    try:
        if options.command == "install":
            assert options.source is not None
            await package_manager.install_and_persist(options.source, local=options.local)
            print(f"Installed {options.source}")
            return True

        if options.command == "remove":
            assert options.source is not None
            removed = await package_manager.remove_and_persist(options.source, local=options.local)
            if not removed:
                print(f"No matching package found for {options.source}", file=sys.stderr)
                sys.exit(1)
            print(f"Removed {options.source}")
            return True

        if options.command == "list":
            configured_packages = package_manager.list_configured_packages()
            user_packages = [pkg for pkg in configured_packages if pkg["scope"] == "user"]
            project_packages = [pkg for pkg in configured_packages if pkg["scope"] == "project"]

            if not configured_packages:
                print("No packages installed.")
                return True

            def format_package(pkg: dict[str, object]) -> None:
                source = str(pkg.get("source", ""))
                display = f"{source} (filtered)" if pkg.get("filtered") else source
                print(f"  {display}")
                installed_path = pkg.get("installedPath")
                if installed_path:
                    print(f"    {installed_path}")

            if user_packages:
                print("User packages:")
                for pkg in user_packages:
                    format_package(pkg)

            if project_packages:
                if user_packages:
                    print()
                print("Project packages:")
                for pkg in project_packages:
                    format_package(pkg)
            return True

        if options.command == "update":
            target = options.update_target or UpdateTarget(type="self")
            if options.show_extensions_skipped_note:
                print(
                    f"Extensions are skipped. Run {APP_NAME} update --extensions to update extensions."
                )
            if _update_target_includes_extensions(target):
                update_source = target.source if target.type == "extensions" else None
                await package_manager.update(update_source)
                if update_source:
                    print(f"Updated {update_source}")
                else:
                    print("Updated packages")
            if _update_target_includes_self(target):
                self_update_plan = await _get_self_update_plan(options.force)
                if not self_update_plan.get("shouldRun"):
                    return True
                install_method = detect_install_method()
                if sys.platform == "win32" and install_method not in ("npm", "pnpm"):
                    print(
                        f"{APP_NAME} self-update on Windows is only supported for npm and pnpm installs.",
                        file=sys.stderr,
                    )
                    print(
                        f"Detected install method: {install_method}. Update {APP_NAME} manually.",
                        file=sys.stderr,
                    )
                    sys.exit(1)
                npm_command = settings_manager.get_global_settings().get("npmCommand")
                self_update_command = get_self_update_command(
                    PACKAGE_NAME,
                    npm_command,
                    self_update_plan.get("packageName", PACKAGE_NAME),
                )
                if not self_update_command:
                    print(
                        get_self_update_unavailable_instruction(
                            PACKAGE_NAME,
                            npm_command,
                            self_update_plan.get("packageName", PACKAGE_NAME),
                        ),
                        file=sys.stderr,
                    )
                    sys.exit(1)
                if self_update_plan.get("note"):
                    print(self_update_plan["note"])
                _prepare_windows_npm_self_update()
                _run_self_update(self_update_command)
                print(f"Updated {APP_NAME}")
            return True
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)

    return True
