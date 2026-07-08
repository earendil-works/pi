from pathlib import Path

from pi_mono.utils.changelog import (
    ChangelogEntry,
    compare_versions,
    format_changelog_markdown,
    get_new_entries,
    normalize_changelog_links,
    parse_changelog,
)

SAMPLE_CHANGELOG = """\
# Changelog

## [0.2.0]

### Added
- Feature A ([#1](issues/1))

## [0.1.0]

### Fixed
- Bug B
"""


def test_parse_changelog(tmp_path: Path) -> None:
    path = tmp_path / "CHANGELOG.md"
    path.write_text(SAMPLE_CHANGELOG, encoding="utf-8")
    entries = parse_changelog(path)
    assert len(entries) == 2
    assert entries[0].version == "0.2.0"
    assert "Feature A" in entries[0].content


def test_get_new_entries() -> None:
    entries = [
        ChangelogEntry(0, 1, 0, "old"),
        ChangelogEntry(0, 2, 0, "new"),
    ]
    new_entries = get_new_entries(entries, "0.1.0")
    assert [entry.version for entry in new_entries] == ["0.2.0"]


def test_compare_versions() -> None:
    left = ChangelogEntry(1, 2, 3, "")
    right = ChangelogEntry(1, 2, 4, "")
    assert compare_versions(left, right) < 0


def test_normalize_changelog_links() -> None:
    markdown = "See [issue](issues/1)"
    normalized = normalize_changelog_links(markdown, "1.2.3")
    assert "github.com/earendil-works/pi-mono/tree/v1.2.3/" in normalized


def test_format_changelog_markdown() -> None:
    entries = [ChangelogEntry(0, 2, 0, "## [0.2.0]\n\nAdded feature")]
    text = format_changelog_markdown(entries)
    assert "0.2.0" in text
