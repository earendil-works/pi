import os
import sys
from pathlib import Path
from pi_mono.utils import paths


def test_canonicalize_path(tmp_path):
    existing = tmp_path / "exists.txt"
    existing.touch()
    assert Path(paths.canonicalize_path(str(existing))).name == "exists.txt"
    assert paths.canonicalize_path("/nonexistent/file") == "/nonexistent/file"


def test_is_local_path():
    assert paths.is_local_path("npm:foo") is False
    assert paths.is_local_path("git:bar") is False
    assert paths.is_local_path("github:owner/repo") is False
    assert paths.is_local_path("http://example.com") is False
    assert paths.is_local_path("https://example.com") is False
    assert paths.is_local_path("ssh://git@github.com") is False
    assert paths.is_local_path("normal/path/to/file") is True
    assert paths.is_local_path("file:///foo/bar") is True


def test_normalize_path(monkeypatch):
    home = str(Path.home())
    assert paths.normalize_path("~") == home
    assert paths.normalize_path("~/foo") == os.path.join(home, "foo")
    if sys.platform == "win32":
        assert paths.normalize_path("~\\bar") == os.path.join(home, "bar")
    else:
        assert paths.normalize_path("~\\bar") == "~\\bar"

    # Options tests
    assert paths.normalize_path("  trimmed_path  ", trim=True) == "trimmed_path"
    assert paths.normalize_path("  trimmed_path  ", trim=False) == "  trimmed_path  "

    # Unicode space normalization (e.g. \u00A0 is a no-break space)
    assert (
        paths.normalize_path("path\u00a0with\u3000spaces", normalize_unicode_spaces=True)
        == "path with spaces"
    )
    assert (
        paths.normalize_path("path\u00a0with\u3000spaces", normalize_unicode_spaces=False)
        == "path\u00a0with\u3000spaces"
    )

    # Strip @ prefix
    assert paths.normalize_path("@file/path", strip_at_prefix=True) == "file/path"
    assert paths.normalize_path("@file/path", strip_at_prefix=False) == "@file/path"

    # file:// path testing
    if sys.platform == "win32":
        assert paths.normalize_path("file:///C:/foo/bar") == "C:\\foo\\bar"
    else:
        assert paths.normalize_path("file:///foo/bar") == "/foo/bar"


def test_resolve_path(tmp_path):
    # Absolute paths
    abs_path = os.path.abspath("/foo/bar")
    assert paths.resolve_path(abs_path) == abs_path

    # Relative path resolution
    base = str(tmp_path)
    res = paths.resolve_path("sub/folder", base_dir=base)
    assert res == os.path.abspath(os.path.join(base, "sub/folder"))


def test_get_cwd_relative_path(tmp_path):
    cwd = str(tmp_path)
    file_in_cwd = str(tmp_path / "sub" / "file.txt")

    rel = paths.get_cwd_relative_path(file_in_cwd, cwd)
    assert rel == os.path.join("sub", "file.txt")

    # Outside cwd
    outside_file = str(tmp_path.parent / "other.txt")
    rel_out = paths.get_cwd_relative_path(outside_file, cwd)
    assert rel_out is None


def test_format_path_relative_to_cwd_or_absolute(tmp_path):
    cwd = str(tmp_path)
    file_in_cwd = str(tmp_path / "sub" / "file.txt")

    formatted = paths.format_path_relative_to_cwd_or_absolute(file_in_cwd, cwd)
    assert formatted == "sub/file.txt"

    outside_file = str(tmp_path.parent / "other.txt")
    formatted_out = paths.format_path_relative_to_cwd_or_absolute(outside_file, cwd)
    assert formatted_out.startswith("/") or (sys.platform == "win32" and ":" in formatted_out)
    assert "\\" not in formatted_out


def test_mark_path_ignored_by_cloud_sync(tmp_path):
    dummy = tmp_path / "dummy.txt"
    dummy.touch()
    # Should not raise exception
    paths.mark_path_ignored_by_cloud_sync(str(dummy))
