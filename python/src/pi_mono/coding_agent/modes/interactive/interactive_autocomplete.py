"""Autocomplete provider setup for interactive mode."""

from __future__ import annotations

import shutil
from typing import Any

from pi_mono.coding_agent.core.slash_commands import BUILTIN_SLASH_COMMANDS
from pi_mono.tui.autocomplete import AutocompleteItem, CombinedAutocompleteProvider, SlashCommand


def _find_fd_path() -> str | None:
    return shutil.which("fd") or shutil.which("fdfind")


def build_interactive_autocomplete_provider(
    session: Any,
    *,
    extra_commands: list[SlashCommand] | None = None,
) -> CombinedAutocompleteProvider:
    commands: list[SlashCommand | AutocompleteItem] = []
    for builtin in BUILTIN_SLASH_COMMANDS:
        commands.append(
            SlashCommand(
                name=builtin.name,
                description=builtin.description,
            )
        )

    runner = session.extension_runner
    if runner is not None:
        for resolved in runner.get_registered_commands():
            commands.append(
                SlashCommand(
                    name=resolved.invocation_name,
                    description=resolved.description or f"Extension command ({resolved.name})",
                )
            )

    if extra_commands:
        commands.extend(extra_commands)

    return CombinedAutocompleteProvider(
        commands=commands,
        base_path=session.cwd,
        fd_path=_find_fd_path(),
    )
