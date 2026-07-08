"""Path resolution helpers for coding agent tools."""

from __future__ import annotations

import os
from pathlib import Path

from pi_mono.utils.paths import normalize_path, resolve_path

NARROW_NO_BREAK_SPACE = "\u202f"


def try_macos_screenshot_path(file_path: str) -> str:
    return file_path.replace(" AM.", f"{NARROW_NO_BREAK_SPACE}AM.").replace(
        " PM.", f"{NARROW_NO_BREAK_SPACE}PM."
    )


def try_nfd_variant(file_path: str) -> str:
    return file_path.normalize("NFD")


def try_curly_quote_variant(file_path: str) -> str:
    return file_path.replace("'", "\u2019")


def file_exists(file_path: str) -> bool:
    return os.path.exists(file_path)


async def path_exists(file_path: str) -> bool:
    return os.path.exists(file_path)


def expand_path(file_path: str) -> str:
    return normalize_path(file_path, normalize_unicode_spaces=True, strip_at_prefix=True)


def resolve_to_cwd(file_path: str, cwd: str) -> str:
    return resolve_path(
        file_path,
        cwd,
        normalize_unicode_spaces=True,
        strip_at_prefix=True,
    )


def resolve_read_path(file_path: str, cwd: str) -> str:
    resolved = resolve_to_cwd(file_path, cwd)

    if file_exists(resolved):
        return resolved

    for variant_fn in (
        try_macos_screenshot_path,
        try_nfd_variant,
        try_curly_quote_variant,
        lambda p: try_curly_quote_variant(try_nfd_variant(p)),
    ):
        variant = variant_fn(resolved)
        if variant != resolved and file_exists(variant):
            return variant

    return resolved


async def resolve_read_path_async(file_path: str, cwd: str) -> str:
    return resolve_read_path(file_path, cwd)


def to_posix_path(value: str) -> str:
    return Path(value).as_posix()
