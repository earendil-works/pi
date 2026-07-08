import pytest

from pi_mono.coding_agent.core.tools.edit_diff import (
    apply_edits_to_normalized_content,
    fuzzy_find_text,
    generate_diff_string,
    generate_unified_patch,
    normalize_for_fuzzy_match,
)


def test_normalize_for_fuzzy_match_strips_trailing_whitespace() -> None:
    assert normalize_for_fuzzy_match("line one  \nline two\t") == "line one\nline two"


def test_fuzzy_find_text_matches_without_trailing_whitespace() -> None:
    content = "alpha line  \nbeta line\n"
    result = fuzzy_find_text(content, "alpha line\nbeta line")
    assert result.found is True
    assert result.used_fuzzy_match is True


def test_fuzzy_find_text_prefers_exact_match() -> None:
    content = "exact\nfuzzy   \n"
    result = fuzzy_find_text(content, "fuzzy")
    assert result.found is True
    assert result.used_fuzzy_match is False


def test_apply_edits_preserves_untouched_line_bytes() -> None:
    content = "keep-me\r\nchange me   \nalso-keep\r\n"
    normalized = content.replace("\r\n", "\n")
    applied = apply_edits_to_normalized_content(
        normalized,
        [{"oldText": "change me\n", "newText": "changed\n"}],
        "test.txt",
    )
    assert applied.new_content == "keep-me\nchanged\nalso-keep\n"


def test_apply_edits_rejects_duplicate_fuzzy_matches() -> None:
    content = "dup   \ndup\n"
    with pytest.raises(ValueError, match="occurrences"):
        apply_edits_to_normalized_content(
            content,
            [{"oldText": "dup", "newText": "x"}],
            "test.txt",
        )


def test_generate_unified_patch_uses_standard_headers() -> None:
    patch = generate_unified_patch("src/a.py", "line one\n", "line two\n")
    assert "--- src/a.py" in patch
    assert "+++ src/a.py" in patch
    assert "-line one" in patch
    assert "+line two" in patch


def test_generate_diff_string_returns_edit_diff_result() -> None:
    result = generate_diff_string("alpha\n", "beta\n")
    assert result.diff
    assert result.first_changed_line == 1
