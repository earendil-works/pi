import asyncio
import json
import os
import re
import urllib.request
from typing import Any, TypedDict
from pi_mono.utils.pi_user_agent import get_pi_user_agent

LATEST_VERSION_URL = "https://pi.dev/api/latest-version"
DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000

VERSION_REGEX = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$")


class LatestPiRelease(TypedDict, total=False):
    version: str
    packageName: str
    note: str


class ParsedVersion(TypedDict, total=False):
    major: int
    minor: int
    patch: int
    prerelease: str


def parse_package_version(version: str) -> ParsedVersion | None:
    """Parse a semver version string into its major, minor, patch, and prerelease components."""
    match = VERSION_REGEX.match(version.strip())
    if not match:
        return None
    return {
        "major": int(match.group(1)),
        "minor": int(match.group(2)),
        "patch": int(match.group(3)),
        "prerelease": match.group(4) or "",
    }


def compare_package_versions(left_version: str, right_version: str) -> int | None:
    """Compare two semver version strings."""
    left = parse_package_version(left_version)
    right = parse_package_version(right_version)
    if not left or not right:
        return None

    if left["major"] != right["major"]:
        return left["major"] - right["major"]
    if left["minor"] != right["minor"]:
        return left["minor"] - right["minor"]
    if left["patch"] != right["patch"]:
        return left["patch"] - right["patch"]

    left_prerelease = left.get("prerelease", "")
    right_prerelease = right.get("prerelease", "")

    if left_prerelease == right_prerelease:
        return 0
    if not left_prerelease:
        return 1
    if not right_prerelease:
        return -1

    if left_prerelease < right_prerelease:
        return -1
    return 1


def is_newer_package_version(candidate_version: str, current_version: str) -> bool:
    """Check if the candidate version is newer than the current version."""
    comparison = compare_package_versions(candidate_version, current_version)
    if comparison is not None:
        return comparison > 0
    return candidate_version.strip() != current_version.strip()


def _fetch_version_sync(url: str, headers: dict[str, str], timeout: float) -> dict[str, Any] | None:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if response.status != 200:
                return None
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


async def get_latest_pi_release(
    current_version: str,
    timeout_ms: int | None = None,
) -> LatestPiRelease | None:
    """Fetch the latest release information from the registry."""
    if os.environ.get("PI_SKIP_VERSION_CHECK") or os.environ.get("PI_OFFLINE"):
        return None

    timeout = (timeout_ms or DEFAULT_VERSION_CHECK_TIMEOUT_MS) / 1000.0
    headers = {
        "User-Agent": get_pi_user_agent(current_version),
        "Accept": "application/json",
    }

    # Run network request in thread pool
    data = await asyncio.to_thread(_fetch_version_sync, LATEST_VERSION_URL, headers, timeout)
    if not data or not isinstance(data, dict):
        return None

    version = data.get("version")
    if not isinstance(version, str) or not version.strip():
        return None

    pkg_name = data.get("packageName")
    package_name = pkg_name.strip() if isinstance(pkg_name, str) and pkg_name.strip() else None

    note_val = data.get("note")
    note = note_val.strip() if isinstance(note_val, str) and note_val.strip() else None

    result: LatestPiRelease = {
        "version": version.strip(),
    }
    if package_name:
        result["packageName"] = package_name
    if note:
        result["note"] = note
    return result


async def get_latest_pi_version(
    current_version: str,
    timeout_ms: int | None = None,
) -> str | None:
    """Fetch and return only the latest version string."""
    release = await get_latest_pi_release(current_version, timeout_ms=timeout_ms)
    return release.get("version") if release else None


async def check_for_new_pi_version(current_version: str) -> LatestPiRelease | None:
    """Check if there is a new version available compared to the current version."""
    try:
        latest_release = await get_latest_pi_release(current_version)
        if latest_release and is_newer_package_version(latest_release["version"], current_version):
            return latest_release
        return None
    except Exception:
        return None
