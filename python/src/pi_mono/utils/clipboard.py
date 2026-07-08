"""Clipboard text helpers.

Read path mirrors packages/coding-agent clipboard tool fallbacks (pbpaste/xclip).
"""

from __future__ import annotations

import platform
import shutil
import subprocess


def read_clipboard_text() -> str:
    """Read plain text from the system clipboard."""
    system = platform.system().lower()

    if system == "darwin":
        return _run_capture(["pbpaste"])

    if system == "windows":
        return _run_capture(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-Clipboard -Raw",
            ]
        )

    if shutil.which("xclip"):
        return _run_capture(["xclip", "-selection", "clipboard", "-o"])

    if shutil.which("xsel"):
        return _run_capture(["xsel", "--clipboard", "--output"])

    raise RuntimeError("No clipboard reader available (expected pbpaste, xclip, or xsel)")


def _run_capture(command: list[str]) -> str:
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except FileNotFoundError as error:
        raise RuntimeError(f"Clipboard command not found: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        stderr = (error.stderr or "").strip()
        message = stderr or f"command failed with exit code {error.returncode}"
        raise RuntimeError(message) from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"Clipboard command timed out: {command[0]}") from error

    if result.stdout is None:
        return ""
    return result.stdout


def write_clipboard_text(text: str) -> None:
    """Write plain text to the system clipboard."""
    system = platform.system().lower()

    if system == "darwin":
        subprocess.run(["pbcopy"], input=text, text=True, check=True, timeout=5)
        return

    if system == "windows":
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
            input=text,
            text=True,
            check=True,
            timeout=5,
        )
        return

    if shutil.which("xclip"):
        subprocess.run(
            ["xclip", "-selection", "clipboard"], input=text, text=True, check=True, timeout=5
        )
        return

    if shutil.which("xsel"):
        subprocess.run(
            ["xsel", "--clipboard", "--input"], input=text, text=True, check=True, timeout=5
        )
        return

    raise RuntimeError("No clipboard writer available (expected pbcopy, xclip, or xsel)")
