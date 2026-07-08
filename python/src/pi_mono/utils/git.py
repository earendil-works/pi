"""Git helpers for branch names and basic URL parsing."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass
class GitSource:
    type: str
    repo: str
    host: str
    path: str
    ref: str | None = None
    pinned: bool = False


def get_current_branch(cwd: str) -> str | None:
    """Return the current git branch name, or None if unavailable or detached."""
    try:
        result = subprocess.run(
            ["git", "--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    branch = result.stdout.strip()
    return branch or None


def _split_ref(url: str) -> tuple[str, str | None]:
    scp_match = re.match(r"^git@([^:]+):(.+)$", url)
    if scp_match:
        path_with_ref = scp_match.group(2)
        ref_sep = path_with_ref.find("@")
        if ref_sep < 0:
            return url, None
        repo_path = path_with_ref[:ref_sep]
        ref = path_with_ref[ref_sep + 1 :]
        if not repo_path or not ref:
            return url, None
        return f"git@{scp_match.group(1)}:{repo_path}", ref

    if "://" in url:
        try:
            parsed = urlparse(url)
            path_with_ref = parsed.path.lstrip("/")
            ref_sep = path_with_ref.find("@")
            if ref_sep < 0:
                return url, None
            repo_path = path_with_ref[:ref_sep]
            ref = path_with_ref[ref_sep + 1 :]
            if not repo_path or not ref:
                return url, None
            parsed = parsed._replace(path=f"/{repo_path}")
            return parsed.geturl().rstrip("/"), ref
        except ValueError:
            return url, None

    slash_index = url.find("/")
    if slash_index < 0:
        return url, None
    host = url[:slash_index]
    path_with_ref = url[slash_index + 1 :]
    ref_sep = path_with_ref.find("@")
    if ref_sep < 0:
        return url, None
    repo_path = path_with_ref[:ref_sep]
    ref = path_with_ref[ref_sep + 1 :]
    if not repo_path or not ref:
        return url, None
    return f"{host}/{repo_path}", ref


def parse_git_url(source: str) -> GitSource | None:
    """Parse a git source URL into a GitSource (minimal port of git.ts)."""
    trimmed = source.strip()
    has_git_prefix = trimmed.startswith("git:")
    url = trimmed[4:].strip() if has_git_prefix else trimmed

    if not has_git_prefix and not re.match(r"^(https?|ssh|git)://", url, re.IGNORECASE):
        return None

    repo_without_ref, ref = _split_ref(url)
    host = ""
    path = ""

    scp_match = re.match(r"^git@([^:]+):(.+)$", repo_without_ref)
    if scp_match:
        host = scp_match.group(1)
        path = scp_match.group(2)
        repo = repo_without_ref
    elif re.match(r"^(https?|ssh|git)://", repo_without_ref, re.IGNORECASE):
        try:
            parsed = urlparse(repo_without_ref)
            host = parsed.hostname or ""
            path = parsed.path.lstrip("/")
            repo = repo_without_ref
        except ValueError:
            return None
    else:
        slash_index = repo_without_ref.find("/")
        if slash_index < 0:
            return None
        host = repo_without_ref[:slash_index]
        path = repo_without_ref[slash_index + 1 :]
        if "." not in host and host != "localhost":
            return None
        repo = f"https://{repo_without_ref}"

    normalized_path = path.removesuffix(".git").lstrip("/")
    if not host or not normalized_path or normalized_path.count("/") < 1:
        return None

    return GitSource(
        type="git",
        repo=repo,
        host=host,
        path=normalized_path,
        ref=ref,
        pinned=bool(ref),
    )
