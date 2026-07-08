"""Colored diff rendering for interactive tool output."""

from __future__ import annotations

import difflib
import re
from typing import TypedDict

from pi_mono.coding_agent.modes.interactive.theme.theme import theme

_DIFF_LINE_RE = re.compile(r"^([-+\s])(\s*\d*)\s(.*)$")
_WORD_RE = re.compile(r"\S+|\s+")


class RenderDiffOptions(TypedDict, total=False):
    filePath: str


def _parse_diff_line(line: str) -> dict[str, str] | None:
    match = _DIFF_LINE_RE.match(line)
    if not match:
        return None
    return {"prefix": match.group(1), "lineNum": match.group(2), "content": match.group(3)}


def _replace_tabs(text: str) -> str:
    return text.replace("\t", "   ")


def _diff_words(old_content: str, new_content: str) -> list[tuple[str, str]]:
    old_tokens = _WORD_RE.findall(old_content)
    new_tokens = _WORD_RE.findall(new_content)
    matcher = difflib.SequenceMatcher(None, old_tokens, new_tokens)
    parts: list[tuple[str, str]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            value = "".join(old_tokens[i1:i2])
            if value:
                parts.append(("equal", value))
        elif tag == "delete":
            value = "".join(old_tokens[i1:i2])
            if value:
                parts.append(("removed", value))
        elif tag == "insert":
            value = "".join(new_tokens[j1:j2])
            if value:
                parts.append(("added", value))
        else:
            removed = "".join(old_tokens[i1:i2])
            added = "".join(new_tokens[j1:j2])
            if removed:
                parts.append(("removed", removed))
            if added:
                parts.append(("added", added))
    return parts


def _render_intra_line_diff(old_content: str, new_content: str) -> tuple[str, str]:
    removed_line = ""
    added_line = ""
    is_first_removed = True
    is_first_added = True

    for part_tag, value in _diff_words(old_content, new_content):
        if part_tag == "removed":
            leading_ws_match = re.match(r"^(\s*)", value)
            leading_ws = leading_ws_match.group(1) if leading_ws_match else ""
            trimmed = value[len(leading_ws) :]
            if is_first_removed:
                removed_line += leading_ws
                is_first_removed = False
            if trimmed:
                removed_line += theme.inverse(trimmed)
        elif part_tag == "added":
            leading_ws_match = re.match(r"^(\s*)", value)
            leading_ws = leading_ws_match.group(1) if leading_ws_match else ""
            trimmed = value[len(leading_ws) :]
            if is_first_added:
                added_line += leading_ws
                is_first_added = False
            if trimmed:
                added_line += theme.inverse(trimmed)
        else:
            removed_line += value
            added_line += value

    return removed_line, added_line


def is_display_diff(diff_text: str) -> bool:
    for line in diff_text.split("\n"):
        if not line.strip():
            continue
        return _parse_diff_line(line) is not None
    return False


def render_diff(diff_text: str, _options: RenderDiffOptions | None = None) -> str:
    lines = diff_text.split("\n")
    result: list[str] = []
    index = 0

    while index < len(lines):
        line = lines[index]
        parsed = _parse_diff_line(line)

        if not parsed:
            result.append(theme.fg("toolDiffContext", line))
            index += 1
            continue

        if parsed["prefix"] == "-":
            removed_lines: list[dict[str, str]] = []
            while index < len(lines):
                current = _parse_diff_line(lines[index])
                if not current or current["prefix"] != "-":
                    break
                removed_lines.append(current)
                index += 1

            added_lines: list[dict[str, str]] = []
            while index < len(lines):
                current = _parse_diff_line(lines[index])
                if not current or current["prefix"] != "+":
                    break
                added_lines.append(current)
                index += 1

            if len(removed_lines) == 1 and len(added_lines) == 1:
                removed = removed_lines[0]
                added = added_lines[0]
                removed_line, added_line = _render_intra_line_diff(
                    _replace_tabs(removed["content"]),
                    _replace_tabs(added["content"]),
                )
                result.append(theme.fg("toolDiffRemoved", f"-{removed['lineNum']} {removed_line}"))
                result.append(theme.fg("toolDiffAdded", f"+{added['lineNum']} {added_line}"))
            else:
                for removed in removed_lines:
                    result.append(
                        theme.fg(
                            "toolDiffRemoved",
                            f"-{removed['lineNum']} {_replace_tabs(removed['content'])}",
                        )
                    )
                for added in added_lines:
                    result.append(
                        theme.fg(
                            "toolDiffAdded",
                            f"+{added['lineNum']} {_replace_tabs(added['content'])}",
                        )
                    )
        elif parsed["prefix"] == "+":
            result.append(
                theme.fg(
                    "toolDiffAdded",
                    f"+{parsed['lineNum']} {_replace_tabs(parsed['content'])}",
                )
            )
            index += 1
        else:
            result.append(
                theme.fg(
                    "toolDiffContext",
                    f" {parsed['lineNum']} {_replace_tabs(parsed['content'])}",
                )
            )
            index += 1

    return "\n".join(result)
