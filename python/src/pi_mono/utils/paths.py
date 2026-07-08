import os
import re
import sys
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

UNICODE_SPACES = re.compile(r"[\u00A0\u2000-\u200A\u202F\u205F\u3000]")


def canonicalize_path(path: str) -> str:
    """Resolve a path to its canonical (real) form, following symlinks."""
    try:
        return os.path.realpath(path)
    except Exception:
        return path


def is_local_path(value: str) -> bool:
    """Returns True if the value is NOT a package source or remote URL protocol."""
    trimmed = value.strip()
    if (
        trimmed.startswith("npm:")
        or trimmed.startswith("git:")
        or trimmed.startswith("github:")
        or trimmed.startswith("http:")
        or trimmed.startswith("https:")
        or trimmed.startswith("ssh:")
    ):
        return False
    return True


def normalize_path(
    input_str: str,
    trim: bool = False,
    expand_tilde: bool = True,
    home_dir: str | None = None,
    strip_at_prefix: bool = False,
    normalize_unicode_spaces: bool = False,
) -> str:
    """Normalize path inputs by stripping spaces, expanding tilde, and handling file:// URLs."""
    normalized = input_str.strip() if trim else input_str

    if normalize_unicode_spaces:
        normalized = UNICODE_SPACES.sub(" ", normalized)

    if strip_at_prefix and normalized.startswith("@"):
        normalized = normalized[1:]

    if expand_tilde:
        home = home_dir or str(Path.home())
        if normalized == "~":
            return home
        if normalized.startswith("~/") or (
            sys.platform == "win32" and normalized.startswith("~\\")
        ):
            return os.path.join(home, normalized[2:])

    if normalized.startswith("file://"):
        parsed = urlparse(normalized)
        return url2pathname(parsed.path)

    return normalized


def resolve_path(
    input_str: str,
    base_dir: str | None = None,
    trim: bool = False,
    expand_tilde: bool = True,
    home_dir: str | None = None,
    strip_at_prefix: bool = False,
    normalize_unicode_spaces: bool = False,
) -> str:
    """Resolve a path relative to a base directory (defaults to cwd) after normalizing both."""
    if base_dir is None:
        base_dir = os.getcwd()

    normalized = normalize_path(
        input_str,
        trim=trim,
        expand_tilde=expand_tilde,
        home_dir=home_dir,
        strip_at_prefix=strip_at_prefix,
        normalize_unicode_spaces=normalize_unicode_spaces,
    )

    normalized_base_dir = normalize_path(base_dir)

    if os.path.isabs(normalized):
        return os.path.abspath(normalized)
    else:
        return os.path.abspath(os.path.join(normalized_base_dir, normalized))


def get_cwd_relative_path(file_path: str, cwd: str) -> str | None:
    """Get the relative path from cwd, returning None if the file is outside cwd."""
    resolved_cwd = resolve_path(cwd)
    resolved_path = resolve_path(file_path, resolved_cwd)

    try:
        relative_path = os.path.relpath(resolved_path, resolved_cwd)
    except ValueError:
        return None

    sep = os.path.sep
    is_inside_cwd = relative_path == "" or (
        relative_path != ".."
        and not relative_path.startswith(f"..{sep}")
        and not os.path.isabs(relative_path)
    )

    if is_inside_cwd:
        return relative_path or "."
    return None


def format_path_relative_to_cwd_or_absolute(file_path: str, cwd: str) -> str:
    """Format file path relative to cwd if inside it, otherwise absolute, using forward slashes."""
    absolute_path = resolve_path(file_path, cwd)
    rel_path = get_cwd_relative_path(absolute_path, cwd)
    target_path = rel_path if rel_path is not None else absolute_path
    return target_path.replace(os.path.sep, "/")


def mark_path_ignored_by_cloud_sync(path: str) -> None:
    """Mark a path to be ignored by cloud sync tools (Dropbox, iCloud)."""
    attrs = []
    if sys.platform == "darwin":
        attrs = ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
    elif sys.platform.startswith("linux"):
        attrs = ["user.com.dropbox.ignored"]

    for attr in attrs:
        try:
            if sys.platform == "darwin":
                subprocess.run(
                    ["xattr", "-w", attr, "1", path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                subprocess.run(
                    ["setfattr", "-n", attr, "-v", "1", path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        except Exception:
            pass
