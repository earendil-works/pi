"""Truncate text to a maximum number of visual lines."""

from __future__ import annotations

from dataclasses import dataclass

from pi_mono.tui.components.text import Text


@dataclass
class VisualTruncateResult:
    visual_lines: list[str]
    skipped_count: int


def truncate_to_visual_lines(
    text: str,
    max_visual_lines: int,
    width: int,
    padding_x: int = 0,
) -> VisualTruncateResult:
    if not text:
        return VisualTruncateResult(visual_lines=[], skipped_count=0)
    temp_text = Text(text, padding_x, 0)
    all_visual_lines = temp_text.render(width)
    if len(all_visual_lines) <= max_visual_lines:
        return VisualTruncateResult(visual_lines=all_visual_lines, skipped_count=0)
    truncated_lines = all_visual_lines[-max_visual_lines:]
    return VisualTruncateResult(
        visual_lines=truncated_lines,
        skipped_count=len(all_visual_lines) - max_visual_lines,
    )
