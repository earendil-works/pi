import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, TypedDict

# =============================================================================
# Bun Runtime Emulation for Compatibility
# =============================================================================

IS_BUN_BINARY: bool = False
IS_BUN_RUNTIME: bool = False

# =============================================================================
# Package Directory & Install Detection
# =============================================================================


def get_package_dir() -> Path:
    """Get the base directory of the package."""
    env_dir = os.environ.get("PI_PACKAGE_DIR")
    if env_dir:
        return Path(env_dir).resolve()

    current = Path(__file__).resolve().parent
    for parent in [current] + list(current.parents):
        # In a monorepo, locate the coding-agent package
        if (parent / "packages/coding-agent/package.json").exists():
            return (parent / "packages/coding-agent").resolve()
        if (parent / "package.json").exists() and parent.name == "coding-agent":
            return parent.resolve()

    return current


def get_package_json_path() -> Path:
    return get_package_dir() / "package.json"


def get_readme_path() -> Path:
    return get_package_dir() / "README.md"


def get_docs_path() -> Path:
    return get_package_dir() / "docs"


def get_examples_path() -> Path:
    return get_package_dir() / "examples"


def get_changelog_path() -> Path:
    return get_package_dir() / "CHANGELOG.md"


# =============================================================================
# Load Configuration from package.json
# =============================================================================

pkg: dict[str, Any] = {}
try:
    with open(get_package_json_path(), "r", encoding="utf-8") as f:
        pkg = json.load(f)
except Exception:
    pass

pi_config = pkg.get("piConfig", {})
pi_config_name = pi_config.get("name")

PACKAGE_NAME: str = pkg.get("name", "@earendil-works/pi-coding-agent")
APP_NAME: str = pi_config_name or "pi"
APP_TITLE: str = APP_NAME if pi_config_name else "π"
CONFIG_DIR_NAME: str = pi_config.get("configDir", ".pi")
VERSION: str = pkg.get("version", "0.0.0")

ENV_AGENT_DIR = f"{APP_NAME.upper()}_CODING_AGENT_DIR"
ENV_SESSION_DIR = f"{APP_NAME.upper()}_CODING_AGENT_SESSION_DIR"


def expand_tilde_path(path: str) -> str:
    normalized = path
    if normalized == "~":
        return str(Path.home())
    if normalized.startswith("~/") or normalized.startswith("~\\"):
        return os.path.join(str(Path.home()), normalized[2:])
    if normalized.startswith("file://"):
        from urllib.parse import urlparse
        from urllib.request import url2pathname

        parsed = urlparse(normalized)
        return url2pathname(parsed.path)
    return normalized


# =============================================================================
# User Config Paths (~/.pi/agent/*)
# =============================================================================


def get_agent_dir() -> Path:
    """Get the agent config directory (e.g., ~/.pi/agent/)"""
    env_dir = os.environ.get(ENV_AGENT_DIR)
    if env_dir:
        return Path(expand_tilde_path(env_dir)).resolve()
    return Path(os.path.expanduser("~")) / CONFIG_DIR_NAME / "agent"


def get_custom_themes_dir() -> Path:
    return get_agent_dir() / "themes"


def get_models_path() -> Path:
    return get_agent_dir() / "models.json"


def get_auth_path() -> Path:
    return get_agent_dir() / "auth.json"


def get_settings_path() -> Path:
    return get_agent_dir() / "settings.json"


def get_tools_dir() -> Path:
    return get_agent_dir() / "tools"


def get_bin_dir() -> Path:
    return get_agent_dir() / "bin"


def get_prompts_dir() -> Path:
    return get_agent_dir() / "prompts"


def get_sessions_dir() -> Path:
    return get_agent_dir() / "sessions"


def get_debug_log_path() -> Path:
    return get_agent_dir() / f"{APP_NAME}-debug.log"


# =============================================================================
# Self-Update Command Structures and Detection
# =============================================================================


class SelfUpdateCommandStep(TypedDict):
    command: str
    args: list[str]
    display: str


class SelfUpdateCommand(SelfUpdateCommandStep, total=False):
    steps: list[SelfUpdateCommandStep]


def make_self_update_command_step(command: str, args: list[str]) -> SelfUpdateCommandStep:
    display_parts = []
    for arg in [command] + args:
        if re.search(r"\s", arg):
            display_parts.append(f'"{arg}"')
        else:
            display_parts.append(arg)
    return {
        "command": command,
        "args": args,
        "display": " ".join(display_parts),
    }


def make_self_update_command(
    install_step: SelfUpdateCommandStep,
    uninstall_step: SelfUpdateCommandStep | None = None,
) -> SelfUpdateCommand:
    if not uninstall_step:
        # A SelfUpdateCommand is fully compatible with SelfUpdateCommandStep
        # but can also contain the optional 'steps' field.
        return install_step  # type: ignore[return-value]
    return {
        "command": install_step["command"],
        "args": install_step["args"],
        "display": f"{uninstall_step['display']} && {install_step['display']}",
        "steps": [uninstall_step, install_step],
    }


def detect_install_method() -> str:
    if IS_BUN_BINARY:
        return "bun-binary"

    current_dir = Path(__file__).resolve().parent
    # ExecPath equivalence
    exec_path = sys.executable or ""
    resolved_path = f"{current_dir}\0{exec_path}".lower().replace("\\", "/")

    if "/pnpm/" in resolved_path or "/.pnpm/" in resolved_path:
        return "pnpm"
    if "/yarn/" in resolved_path or "/.yarn/" in resolved_path:
        return "yarn"
    if IS_BUN_RUNTIME or "/install/global/node_modules/" in resolved_path:
        return "bun"
    if "/npm/" in resolved_path or "/node_modules/" in resolved_path:
        return "npm"

    return "unknown"


def get_inferred_npm_install() -> dict[str, str] | None:
    package_dir = get_package_dir()
    import ntpath
    import posixpath

    is_windows = (sys.platform == "win32") or ("\\" in str(package_dir))
    p = ntpath if is_windows else posixpath

    package_dir_str = str(package_dir)
    parent = p.dirname(package_dir_str)
    parent_name = p.basename(parent)

    root: str | None = None
    if parent_name.startswith("@") and p.basename(p.dirname(parent)) == "node_modules":
        root = p.dirname(parent)
    elif parent_name == "node_modules":
        root = parent

    if not root:
        return None

    root_parent = p.dirname(root)
    if p.basename(root_parent) == "lib":
        return {"root": root, "prefix": p.dirname(root_parent)}

    return None


def get_self_update_command_for_method(
    method: str,
    installed_package_name: str,
    update_package_name: str | None = None,
    npm_command: list[str] | None = None,
) -> SelfUpdateCommand | None:
    if update_package_name is None:
        update_package_name = installed_package_name

    if method == "bun-binary":
        return None
    elif method == "pnpm":
        uninstall_step = (
            None
            if update_package_name == installed_package_name
            else make_self_update_command_step("pnpm", ["remove", "-g", installed_package_name])
        )
        return make_self_update_command(
            make_self_update_command_step(
                "pnpm",
                [
                    "install",
                    "-g",
                    "--ignore-scripts",
                    "--config.minimumReleaseAge=0",
                    update_package_name,
                ],
            ),
            uninstall_step,
        )
    elif method == "yarn":
        uninstall_step = (
            None
            if update_package_name == installed_package_name
            else make_self_update_command_step("yarn", ["global", "remove", installed_package_name])
        )
        return make_self_update_command(
            make_self_update_command_step(
                "yarn",
                ["global", "add", "--ignore-scripts", update_package_name],
            ),
            uninstall_step,
        )
    elif method == "bun":
        uninstall_step = (
            None
            if update_package_name == installed_package_name
            else make_self_update_command_step("bun", ["uninstall", "-g", installed_package_name])
        )
        return make_self_update_command(
            make_self_update_command_step(
                "bun",
                [
                    "install",
                    "-g",
                    "--ignore-scripts",
                    "--minimum-release-age=0",
                    update_package_name,
                ],
            ),
            uninstall_step,
        )
    elif method == "npm":
        cmd_args = npm_command or []
        command = cmd_args[0] if cmd_args else "npm"
        npm_args = cmd_args[1:] if cmd_args else []

        inferred = None if npm_command else get_inferred_npm_install()
        prefix_args = list(npm_args)
        if inferred:
            prefix_args.extend(["--prefix", inferred["prefix"]])

        install_step = make_self_update_command_step(
            command,
            prefix_args
            + ["install", "-g", "--ignore-scripts", "--min-release-age=0", update_package_name],
        )
        uninstall_step = (
            None
            if update_package_name == installed_package_name
            else make_self_update_command_step(
                command,
                prefix_args + ["uninstall", "-g", installed_package_name],
            )
        )
        return make_self_update_command(install_step, uninstall_step)

    return None


def read_command_output(
    command: str,
    args: list[str],
    require_success: bool = False,
) -> str | None:
    try:
        cmd_path = shutil.which(command) or command
        result = subprocess.run(
            [cmd_path] + args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
        if require_success:
            reason = result.stderr.strip() or f"exit code {result.returncode}"
            raise RuntimeError(f"Failed to run {' '.join([command] + args)}: {reason}")
    except Exception as e:
        if require_success:
            raise RuntimeError(f"Failed to run {' '.join([command] + args)}: {e}") from e
    return None


def get_global_package_roots(
    method: str,
    _package_name: str,
    npm_command: list[str] | None = None,
) -> list[str]:
    home = str(Path.home())
    if method == "npm":
        configured = bool(npm_command)
        cmd_args = npm_command or []
        command = cmd_args[0] if cmd_args else "npm"
        npm_args = cmd_args[1:] if cmd_args else []

        if configured and command == "bun":
            bun_bin = read_command_output(
                command, npm_args + ["pm", "bin", "-g"], require_success=True
            )
            roots = [os.path.join(home, ".bun", "install", "global", "node_modules")]
            if bun_bin:
                roots.append(
                    os.path.join(os.path.dirname(bun_bin), "install", "global", "node_modules")
                )
            return roots

        root = read_command_output(command, npm_args + ["root", "-g"], require_success=configured)
        inferred = None if configured else get_inferred_npm_install()
        roots_list: list[str] = []
        if root:
            roots_list.append(root)
        if inferred and inferred.get("root"):
            roots_list.append(inferred["root"])
        return roots_list

    elif method == "pnpm":
        root = read_command_output("pnpm", ["root", "-g"])
        return [root, os.path.dirname(root)] if root else []

    elif method == "yarn":
        dir_val = read_command_output("yarn", ["global", "dir"])
        return [dir_val, os.path.join(dir_val, "node_modules")] if dir_val else []

    elif method == "bun":
        bun_bin = read_command_output("bun", ["pm", "bin", "-g"])
        roots = [os.path.join(home, ".bun", "install", "global", "node_modules")]
        if bun_bin:
            roots.append(
                os.path.join(os.path.dirname(bun_bin), "install", "global", "node_modules")
            )
        return roots

    return []


def normalize_existing_path_for_comparison(path_str: str, resolve_symlinks: bool) -> str | None:
    try:
        if resolve_symlinks:
            normalized_path_str = os.path.realpath(path_str)
        else:
            normalized_path_str = os.path.abspath(path_str)

        if not os.path.exists(normalized_path_str):
            return None

        if sys.platform == "win32":
            normalized_path_str = normalized_path_str.lower()

        return normalized_path_str
    except Exception:
        return None


def get_path_comparison_candidates(path_str: str) -> list[str]:
    c1 = normalize_existing_path_for_comparison(path_str, False)
    c2 = normalize_existing_path_for_comparison(path_str, True)
    candidates = []
    if c1:
        candidates.append(c1)
    if c2 and c2 not in candidates:
        candidates.append(c2)
    return candidates


def get_entrypoint_package_dir() -> str | None:
    if not sys.argv or len(sys.argv) == 0 or not sys.argv[0]:
        return None
    entrypoint = sys.argv[0]
    try:
        dir_val = os.path.dirname(os.path.abspath(entrypoint))
    except Exception:
        return None

    while dir_val != os.path.dirname(dir_val):
        if os.path.exists(os.path.join(dir_val, "package.json")):
            return dir_val
        dir_val = os.path.dirname(dir_val)
    return None


def is_self_update_path_writable() -> bool:
    package_dir = get_package_dir()
    try:
        parent_dir = package_dir.parent
        return os.access(package_dir, os.W_OK) and os.access(parent_dir, os.W_OK)
    except Exception:
        return False


def is_managed_by_global_package_manager(
    method: str,
    package_name: str,
    npm_command: list[str] | None = None,
) -> bool:
    package_dirs = []

    pkg_dir = get_package_dir()
    if pkg_dir:
        package_dirs.append(str(pkg_dir))

    entry_dir = get_entrypoint_package_dir()
    if entry_dir:
        package_dirs.append(entry_dir)

    package_dir_candidates = []
    for d in package_dirs:
        package_dir_candidates.extend(get_path_comparison_candidates(d))

    global_roots = get_global_package_roots(method, package_name, npm_command)
    sep = os.path.sep

    for root in global_roots:
        for normalized_root in get_path_comparison_candidates(root):
            root_prefix = (
                normalized_root if normalized_root.endswith(sep) else f"{normalized_root}{sep}"
            )
            for package_dir in package_dir_candidates:
                if package_dir.startswith(root_prefix):
                    return True
    return False


def get_self_update_command(
    package_name: str,
    npm_command: list[str] | None = None,
    update_package_name: str | None = None,
) -> SelfUpdateCommand | None:
    if update_package_name is None:
        update_package_name = package_name

    method = detect_install_method()
    command = get_self_update_command_for_method(
        method, package_name, update_package_name, npm_command
    )
    if (
        not command
        or not is_managed_by_global_package_manager(method, package_name, npm_command)
        or not is_self_update_path_writable()
    ):
        return None
    return command


def get_self_update_unavailable_instruction(
    package_name: str,
    npm_command: list[str] | None = None,
    update_package_name: str | None = None,
) -> str:
    if update_package_name is None:
        update_package_name = package_name

    method = detect_install_method()
    if method == "bun-binary":
        return "Download from: https://github.com/earendil-works/pi-mono/releases/latest"

    command = get_self_update_command_for_method(
        method, package_name, update_package_name, npm_command
    )
    if command:
        if (
            is_managed_by_global_package_manager(method, package_name, npm_command)
            and not is_self_update_path_writable()
        ):
            return f"This installation is managed by a global {method} install, but the install path is not writable. Update it yourself with: {command['display']}"
        return f"This installation is not managed by a global {method} install. Update it with the package manager, wrapper, or source checkout that provides it."

    return f"Update {update_package_name} using the package manager, wrapper, or source checkout that provides this installation."


def get_update_instruction(package_name: str) -> str:
    method = detect_install_method()
    command = get_self_update_command_for_method(method, package_name)
    if command:
        return f"Run: {command['display']}"
    return get_self_update_unavailable_instruction(package_name)


# =============================================================================
# Package Asset Paths (shipped with executable)
# =============================================================================


def get_themes_dir() -> Path:
    if IS_BUN_BINARY:
        return get_package_dir() / "theme"
    package_dir = get_package_dir()
    src_or_dist = "src" if (package_dir / "src").exists() else "dist"
    return package_dir / src_or_dist / "modes" / "interactive" / "theme"


def get_export_template_dir() -> Path:
    if IS_BUN_BINARY:
        return get_package_dir() / "export-html"
    package_dir = get_package_dir()
    src_or_dist = "src" if (package_dir / "src").exists() else "dist"
    return package_dir / src_or_dist / "core" / "export-html"


def get_interactive_assets_dir() -> Path:
    if IS_BUN_BINARY:
        return get_package_dir() / "assets"
    package_dir = get_package_dir()
    src_or_dist = "src" if (package_dir / "src").exists() else "dist"
    return package_dir / src_or_dist / "modes" / "interactive" / "assets"


def get_bundled_interactive_asset_path(name: str) -> Path:
    return get_interactive_assets_dir() / name


# =============================================================================
# Helper function
# =============================================================================

DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/"


def get_share_viewer_url(gist_id: str) -> str:
    base_url = os.environ.get("PI_SHARE_VIEWER_URL", DEFAULT_SHARE_VIEWER_URL)
    return f"{base_url}#{gist_id}"
