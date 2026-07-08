"""Utilities for formatting keybinding hints in the UI."""

from __future__ import annotations

import sys

from pi_mono.coding_agent.modes.interactive.theme.theme import theme
from pi_mono.tui.keybindings import get_keybindings


def format_key_text(key: str, *, capitalize: bool = False) -> str:
    parts = key.split("/")
    formatted_parts: list[str] = []
    for part in parts:
        subparts = part.split("+")
        formatted_subparts: list[str] = []
        for subpart in subparts:
            display = subpart
            if sys.platform == "darwin" and subpart.lower() == "alt":
                display = "option"
            if capitalize:
                display = display[:1].upper() + display[1:]
            formatted_subparts.append(display)
        formatted_parts.append("+".join(formatted_subparts))
    return "/".join(formatted_parts)


def key_text(keybinding: str) -> str:
    keys = get_keybindings().get_keys(keybinding)
    if not keys:
        return ""
    return format_key_text("/".join(keys))


def key_display_text(keybinding: str) -> str:
    return format_key_text("/".join(get_keybindings().get_keys(keybinding)), capitalize=True)


def key_hint(keybinding: str, description: str) -> str:
    return theme.fg("dim", key_text(keybinding)) + theme.fg("muted", f" {description}")


def raw_key_hint(key: str, description: str) -> str:
    return theme.fg("dim", format_key_text(key)) + theme.fg("muted", f" {description}")
