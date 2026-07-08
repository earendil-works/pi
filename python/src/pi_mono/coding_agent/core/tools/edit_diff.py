"""Shared diff computation utilities for the edit and similar tools."""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass
from typing import TypedDict


class Edit(TypedDict):
    oldText: str
    newText: str


@dataclass
class AppliedEditsResult:
    base_content: str
    new_content: str


@dataclass
class FuzzyMatchResult:
    found: bool
    index: int
    match_length: int
    used_fuzzy_match: bool
    content_for_replacement: str


@dataclass
class TextReplacement:
    match_index: int
    match_length: int
    new_text: str


@dataclass
class MatchedEdit(TextReplacement):
    edit_index: int


@dataclass
class LineSpan:
    start: int
    end: int


def detect_line_ending(content: str) -> str:
    crlf_idx = content.find("\r\n")
    lf_idx = content.find("\n")
    if lf_idx == -1:
        return "\n"
    if crlf_idx == -1:
        return "\n"
    return "\r\n" if crlf_idx < lf_idx else "\n"


def normalize_to_lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def restore_line_endings(text: str, ending: str) -> str:
    return text.replace("\n", "\r\n") if ending == "\r\n" else text


def normalize_for_fuzzy_match(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = "\n".join(line.rstrip() for line in normalized.split("\n"))
    normalized = re.sub(r"[\u2018\u2019\u201a\u201b]", "'", normalized)
    normalized = re.sub(r"[\u201c\u201d\u201e\u201f]", '"', normalized)
    normalized = re.sub(r"[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]", "-", normalized)
    normalized = re.sub(r"[\u00a0\u2002-\u200a\u202f\u205f\u3000]", " ", normalized)
    return normalized


def _split_lines_with_endings(content: str) -> list[str]:
    return re.findall(r"[^\n]*\n|[^\n]+", content)


def _get_line_spans(content: str) -> list[LineSpan]:
    offset = 0
    spans: list[LineSpan] = []
    for line in _split_lines_with_endings(content):
        span = LineSpan(start=offset, end=offset + len(line))
        offset = span.end
        spans.append(span)
    return spans


def _get_replacement_line_range(
    lines: list[LineSpan], replacement: TextReplacement
) -> tuple[int, int]:
    replacement_start = replacement.match_index
    replacement_end = replacement.match_index + replacement.match_length

    start_line = -1
    for index, line in enumerate(lines):
        if replacement_start >= line.start and replacement_start < line.end:
            start_line = index
            break
    if start_line == -1:
        raise ValueError("Replacement range is outside the base content.")

    end_line = start_line
    while end_line < len(lines) and lines[end_line].end < replacement_end:
        end_line += 1
    if end_line >= len(lines):
        raise ValueError("Replacement range is outside the base content.")

    return start_line, end_line + 1


def _apply_replacements(content: str, replacements: list[TextReplacement], offset: int = 0) -> str:
    result = content
    for replacement in reversed(replacements):
        match_index = replacement.match_index - offset
        result = (
            result[:match_index]
            + replacement.new_text
            + result[match_index + replacement.match_length :]
        )
    return result


def apply_replacements_preserving_unchanged_lines(
    original_content: str,
    base_content: str,
    replacements: list[TextReplacement],
) -> str:
    original_lines = _split_lines_with_endings(original_content)
    base_lines = _get_line_spans(base_content)
    if len(original_lines) != len(base_lines):
        raise ValueError(
            "Cannot preserve unchanged lines because the base content has a different line count."
        )

    groups: list[dict[str, object]] = []
    sorted_replacements = sorted(replacements, key=lambda item: item.match_index)
    for replacement in sorted_replacements:
        start_line, end_line = _get_replacement_line_range(base_lines, replacement)
        current = groups[-1] if groups else None
        if current is not None and start_line < int(current["end_line"]):
            current["end_line"] = max(int(current["end_line"]), end_line)
            cast_replacements = current["replacements"]
            assert isinstance(cast_replacements, list)
            cast_replacements.append(replacement)
            continue
        groups.append(
            {"start_line": start_line, "end_line": end_line, "replacements": [replacement]}
        )

    original_line_index = 0
    result = ""
    for group in groups:
        start_line = int(group["start_line"])
        end_line = int(group["end_line"])
        group_replacements = group["replacements"]
        assert isinstance(group_replacements, list)
        result += "".join(original_lines[original_line_index:start_line])
        group_start_offset = base_lines[start_line].start
        group_end_offset = base_lines[end_line - 1].end
        result += _apply_replacements(
            base_content[group_start_offset:group_end_offset],
            group_replacements,
            group_start_offset,
        )
        original_line_index = end_line
    result += "".join(original_lines[original_line_index:])
    return result


def fuzzy_find_text(content: str, old_text: str) -> FuzzyMatchResult:
    exact_index = content.find(old_text)
    if exact_index != -1:
        return FuzzyMatchResult(
            found=True,
            index=exact_index,
            match_length=len(old_text),
            used_fuzzy_match=False,
            content_for_replacement=content,
        )

    fuzzy_content = normalize_for_fuzzy_match(content)
    fuzzy_old_text = normalize_for_fuzzy_match(old_text)
    fuzzy_index = fuzzy_content.find(fuzzy_old_text)
    if fuzzy_index == -1:
        return FuzzyMatchResult(
            found=False,
            index=-1,
            match_length=0,
            used_fuzzy_match=False,
            content_for_replacement=content,
        )

    return FuzzyMatchResult(
        found=True,
        index=fuzzy_index,
        match_length=len(fuzzy_old_text),
        used_fuzzy_match=True,
        content_for_replacement=fuzzy_content,
    )


def strip_bom(content: str) -> str:
    return content.removeprefix("\ufeff")


def _count_occurrences(content: str, old_text: str) -> int:
    fuzzy_content = normalize_for_fuzzy_match(content)
    fuzzy_old_text = normalize_for_fuzzy_match(old_text)
    if not fuzzy_old_text:
        return 0
    return fuzzy_content.count(fuzzy_old_text)


def _get_not_found_error(path: str, edit_index: int, total_edits: int) -> ValueError:
    if total_edits == 1:
        return ValueError(
            f"Could not find the exact text in {path}. "
            "The old text must match exactly including all whitespace and newlines."
        )
    return ValueError(
        f"Could not find edits[{edit_index}] in {path}. "
        "The oldText must match exactly including all whitespace and newlines."
    )


def _get_duplicate_error(
    path: str, edit_index: int, total_edits: int, occurrences: int
) -> ValueError:
    if total_edits == 1:
        return ValueError(
            f"Found {occurrences} occurrences of the text in {path}. "
            "The text must be unique. Please provide more context to make it unique."
        )
    return ValueError(
        f"Found {occurrences} occurrences of edits[{edit_index}] in {path}. "
        "Each oldText must be unique. Please provide more context to make it unique."
    )


def _get_empty_old_text_error(path: str, edit_index: int, total_edits: int) -> ValueError:
    if total_edits == 1:
        return ValueError(f"oldText must not be empty in {path}.")
    return ValueError(f"edits[{edit_index}].oldText must not be empty in {path}.")


def _get_no_change_error(path: str, total_edits: int) -> ValueError:
    if total_edits == 1:
        return ValueError(
            f"No changes made to {path}. The replacement produced identical content. "
            "This might indicate an issue with special characters or the text not existing as expected."
        )
    return ValueError(f"No changes made to {path}. The replacements produced identical content.")


def apply_edits_to_normalized_content(
    normalized_content: str,
    edits: list[Edit],
    path: str = "<file>",
) -> AppliedEditsResult:
    normalized_edits = [
        {"oldText": normalize_to_lf(edit["oldText"]), "newText": normalize_to_lf(edit["newText"])}
        for edit in edits
    ]

    for index, edit in enumerate(normalized_edits):
        if not edit["oldText"]:
            raise _get_empty_old_text_error(path, index, len(normalized_edits))

    initial_matches = [
        fuzzy_find_text(normalized_content, edit["oldText"]) for edit in normalized_edits
    ]
    used_fuzzy_match = any(match.used_fuzzy_match for match in initial_matches)
    replacement_base_content = (
        normalize_for_fuzzy_match(normalized_content) if used_fuzzy_match else normalized_content
    )

    matched_edits: list[MatchedEdit] = []
    for index, edit in enumerate(normalized_edits):
        match_result = fuzzy_find_text(replacement_base_content, edit["oldText"])
        if not match_result.found:
            raise _get_not_found_error(path, index, len(normalized_edits))

        occurrences = _count_occurrences(replacement_base_content, edit["oldText"])
        if occurrences > 1:
            raise _get_duplicate_error(path, index, len(normalized_edits), occurrences)

        matched_edits.append(
            MatchedEdit(
                edit_index=index,
                match_index=match_result.index,
                match_length=match_result.match_length,
                new_text=edit["newText"],
            )
        )

    matched_edits.sort(key=lambda item: item.match_index)
    for index in range(1, len(matched_edits)):
        previous = matched_edits[index - 1]
        current = matched_edits[index]
        if previous.match_index + previous.match_length > current.match_index:
            raise ValueError(
                f"edits[{previous.edit_index}] and edits[{current.edit_index}] overlap in {path}. "
                "Merge them into one edit or target disjoint regions."
            )

    base_content = normalized_content
    replacements: list[TextReplacement] = [
        TextReplacement(
            match_index=item.match_index,
            match_length=item.match_length,
            new_text=item.new_text,
        )
        for item in matched_edits
    ]
    new_content = (
        apply_replacements_preserving_unchanged_lines(
            normalized_content, replacement_base_content, replacements
        )
        if used_fuzzy_match
        else _apply_replacements(replacement_base_content, replacements)
    )

    if base_content == new_content:
        raise _get_no_change_error(path, len(normalized_edits))

    return AppliedEditsResult(base_content=base_content, new_content=new_content)


@dataclass(frozen=True)
class DisplayDiffResult:
    diff: str
    first_changed_line: int | None


EditDiffResult = DisplayDiffResult


def _split_lines_for_diff(content: str) -> list[str]:
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def generate_display_diff_string(
    old_content: str,
    new_content: str,
    *,
    context_lines: int = 4,
) -> DisplayDiffResult:
    old_lines = _split_lines_for_diff(old_content)
    new_lines = _split_lines_for_diff(new_content)
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines)
    parts: list[tuple[str, list[str]]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            parts.append(("equal", old_lines[i1:i2]))
        elif tag == "delete":
            parts.append(("removed", old_lines[i1:i2]))
        elif tag == "insert":
            parts.append(("added", new_lines[j1:j2]))
        else:
            parts.append(("removed", old_lines[i1:i2]))
            parts.append(("added", new_lines[j1:j2]))

    output: list[str] = []
    max_line_num = max(len(old_lines), len(new_lines), 1)
    line_num_width = len(str(max_line_num))
    old_line_num = 1
    new_line_num = 1
    last_was_change = False
    first_changed_line: int | None = None

    for part_index, (part_tag, raw_lines) in enumerate(parts):
        if part_tag in ("removed", "added"):
            if first_changed_line is None and part_tag == "added":
                first_changed_line = new_line_num
            elif first_changed_line is None and part_tag == "removed":
                first_changed_line = new_line_num

            for line in raw_lines:
                if part_tag == "added":
                    line_num = str(new_line_num).rjust(line_num_width)
                    output.append(f"+{line_num} {line}")
                    new_line_num += 1
                else:
                    line_num = str(old_line_num).rjust(line_num_width)
                    output.append(f"-{line_num} {line}")
                    old_line_num += 1
            last_was_change = True
            continue

        next_is_change = part_index < len(parts) - 1 and parts[part_index + 1][0] in (
            "removed",
            "added",
        )
        has_leading_change = last_was_change
        has_trailing_change = next_is_change

        if has_leading_change and has_trailing_change:
            if len(raw_lines) <= context_lines * 2:
                for line in raw_lines:
                    line_num = str(old_line_num).rjust(line_num_width)
                    output.append(f" {line_num} {line}")
                    old_line_num += 1
                    new_line_num += 1
            else:
                leading_lines = raw_lines[:context_lines]
                trailing_lines = raw_lines[-context_lines:]
                skipped_lines = len(raw_lines) - len(leading_lines) - len(trailing_lines)

                for line in leading_lines:
                    line_num = str(old_line_num).rjust(line_num_width)
                    output.append(f" {line_num} {line}")
                    old_line_num += 1
                    new_line_num += 1

                output.append(f" {'':>{line_num_width}} ...")
                old_line_num += skipped_lines
                new_line_num += skipped_lines

                for line in trailing_lines:
                    line_num = str(old_line_num).rjust(line_num_width)
                    output.append(f" {line_num} {line}")
                    old_line_num += 1
                    new_line_num += 1
        elif has_leading_change:
            shown_lines = raw_lines[:context_lines]
            skipped_lines = len(raw_lines) - len(shown_lines)
            for line in shown_lines:
                line_num = str(old_line_num).rjust(line_num_width)
                output.append(f" {line_num} {line}")
                old_line_num += 1
                new_line_num += 1
            if skipped_lines > 0:
                output.append(f" {'':>{line_num_width}} ...")
                old_line_num += skipped_lines
                new_line_num += skipped_lines
        elif has_trailing_change:
            skipped_lines = max(0, len(raw_lines) - context_lines)
            if skipped_lines > 0:
                output.append(f" {'':>{line_num_width}} ...")
                old_line_num += skipped_lines
                new_line_num += skipped_lines
            for line in raw_lines[skipped_lines:]:
                line_num = str(old_line_num).rjust(line_num_width)
                output.append(f" {line_num} {line}")
                old_line_num += 1
                new_line_num += 1
        else:
            old_line_num += len(raw_lines)
            new_line_num += len(raw_lines)

        last_was_change = False

    return DisplayDiffResult(diff="\n".join(output), first_changed_line=first_changed_line)


def generate_diff_string(
    old_content: str,
    new_content: str,
    *,
    context_lines: int = 4,
) -> EditDiffResult:
    return generate_display_diff_string(
        old_content,
        new_content,
        context_lines=context_lines,
    )


def generate_unified_patch(
    path: str,
    old_content: str,
    new_content: str,
    *,
    context_lines: int = 4,
) -> str:
    old_lines = old_content.splitlines()
    new_lines = new_content.splitlines()
    patch_lines = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=path,
        tofile=path,
        n=context_lines,
        lineterm="",
    )
    return "\n".join(patch_lines) + ("\n" if patch_lines else "")
