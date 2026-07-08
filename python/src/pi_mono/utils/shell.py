import os
import re
import shutil
import subprocess
import sys
from typing import Literal, NotRequired, TypedDict

from pi_mono.config import get_bin_dir


class ShellConfig(TypedDict):
    shell: str
    args: list[str]
    commandTransport: NotRequired[Literal["argv", "stdin"]]


def _is_legacy_wsl_bash_path(path: str) -> bool:
    normalized = path.replace("/", "\\").lower()
    return bool(re.match(r"^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$", normalized))


def _get_bash_shell_config(shell: str) -> ShellConfig:
    if _is_legacy_wsl_bash_path(shell):
        return {"shell": shell, "args": ["-s"], "commandTransport": "stdin"}
    return {"shell": shell, "args": ["-c"]}


def get_shell_config(custom_shell_path: str | None = None) -> ShellConfig:
    """Resolve shell configuration based on platform and optional explicit shell path."""
    if custom_shell_path:
        if os.path.exists(custom_shell_path):
            return _get_bash_shell_config(custom_shell_path)
        raise ValueError(f"Custom shell path not found: {custom_shell_path}")

    if sys.platform == "win32":
        paths = []
        program_files = os.environ.get("ProgramFiles")
        if program_files:
            paths.append(os.path.join(program_files, "Git", "bin", "bash.exe"))
        program_files_x86 = os.environ.get("ProgramFiles(x86)")
        if program_files_x86:
            paths.append(os.path.join(program_files_x86, "Git", "bin", "bash.exe"))

        for path in paths:
            if os.path.exists(path):
                return _get_bash_shell_config(path)

        bash_path = shutil.which("bash.exe") or shutil.which("bash")
        if bash_path:
            return _get_bash_shell_config(bash_path)

        raise RuntimeError(
            "No bash shell found. Options:\n"
            "  1. Install Git for Windows\n"
            "  2. Add your bash to PATH\n"
            "  3. Set shellPath in settings.json"
        )

    if os.path.exists("/bin/bash"):
        return _get_bash_shell_config("/bin/bash")

    bash_path = shutil.which("bash")
    if bash_path:
        return _get_bash_shell_config(bash_path)

    return {"shell": "sh", "args": ["-c"]}


def get_shell_env() -> dict[str, str]:
    """Get process environment with packages bin directory prepended to PATH."""
    bin_dir = str(get_bin_dir())
    env = os.environ.copy()

    # Find the PATH environment variable key in a case-insensitive manner
    path_key = "PATH"
    for key in env.keys():
        if key.upper() == "PATH":
            path_key = key
            break

    current_path = env.get(path_key, "")
    path_entries = [p for p in current_path.split(os.pathsep) if p]

    if bin_dir not in path_entries:
        path_entries.insert(0, bin_dir)
        env[path_key] = os.pathsep.join(path_entries)

    return env


def sanitize_binary_output(str_val: str) -> str:
    """Sanitize binary output for display/storage by removing formatting/control codes."""
    result = []
    for char in str_val:
        code = ord(char)
        # Allow tab, newline, carriage return
        if code in (0x09, 0x0A, 0x0D):
            result.append(char)
            continue
        # Filter control characters
        if code <= 0x1F:
            continue
        # Filter Unicode format characters
        if 0xFFF9 <= code <= 0xFFFB:
            continue
        # Filter surrogate characters
        if 0xD800 <= code <= 0xDFFF:
            continue
        result.append(char)
    return "".join(result)


# Track detached child processes
tracked_detached_child_pids: set[int] = set()


def track_detached_child_pid(pid: int) -> None:
    tracked_detached_child_pids.add(pid)


def untrack_detached_child_pid(pid: int) -> None:
    tracked_detached_child_pids.discard(pid)


def kill_tracked_detached_children() -> None:
    for pid in list(tracked_detached_child_pids):
        kill_process_tree(pid)
    tracked_detached_child_pids.clear()


def kill_process_tree(pid: int) -> None:
    """Kill a process tree (cross-platform)."""
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
        except Exception:
            pass
    else:
        try:
            os.killpg(os.getpgid(pid), 9)  # SIGKILL process group
        except Exception:
            try:
                os.kill(pid, 9)  # SIGKILL single process
            except Exception:
                pass
