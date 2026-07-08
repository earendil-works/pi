"""Minimal semver helpers for npm package resolution."""

from __future__ import annotations

import re

from pi_mono.utils.version_check import compare_package_versions, parse_package_version

EXACT_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+.*)?$")
RANGE_PREFIX_RE = re.compile(r"^(\^|~|>=|<=|>|<|\*)(.*)$")


def is_exact_npm_version(version: str | None) -> bool:
    if not version:
        return False
    return EXACT_VERSION_RE.match(version.strip()) is not None


def get_npm_version_range(version: str | None) -> str | None:
    if not version:
        return None
    trimmed = version.strip()
    if not trimmed:
        return None
    if is_exact_npm_version(trimmed):
        return None
    if RANGE_PREFIX_RE.match(trimmed) or trimmed == "latest":
        return trimmed
    return trimmed


def _compare_versions(left: str, right: str) -> int:
    comparison = compare_package_versions(left, right)
    if comparison is not None:
        return comparison
    if left == right:
        return 0
    return -1 if left < right else 1


def satisfies(version: str, range_spec: str) -> bool:
    trimmed_range = range_spec.strip()
    if trimmed_range in ("*", "latest"):
        return parse_package_version(version) is not None
    if is_exact_npm_version(trimmed_range):
        return _compare_versions(version, trimmed_range) == 0

    match = RANGE_PREFIX_RE.match(trimmed_range)
    if not match:
        return _compare_versions(version, trimmed_range) == 0

    prefix, rest = match.group(1), match.group(2).strip()
    base = parse_package_version(rest)
    candidate = parse_package_version(version)
    if not base or not candidate:
        return False

    if prefix == "^":
        if candidate["major"] != base["major"]:
            return False
        if base["major"] == 0 and candidate["minor"] != base["minor"]:
            return False
        return _compare_versions(version, rest) >= 0

    if prefix == "~":
        if candidate["major"] != base["major"] or candidate["minor"] != base["minor"]:
            return False
        return _compare_versions(version, rest) >= 0

    if prefix == ">=":
        return _compare_versions(version, rest) >= 0
    if prefix == "<=":
        return _compare_versions(version, rest) <= 0
    if prefix == ">":
        return _compare_versions(version, rest) > 0
    if prefix == "<":
        return _compare_versions(version, rest) < 0

    return False


def max_satisfying(versions: list[str], range_spec: str) -> str | None:
    matching = [version for version in versions if satisfies(version, range_spec)]
    if not matching:
        return None
    best = matching[0]
    for version in matching[1:]:
        comparison = compare_package_versions(version, best)
        if comparison is not None and comparison > 0:
            best = version
    return best
