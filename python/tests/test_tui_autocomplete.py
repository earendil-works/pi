import os
import shutil
import tempfile
import pytest
from pi_mono.tui.autocomplete import (
    CombinedAutocompleteProvider,
)
from pi_mono.utils.abort_signals import AbortController

fd_path = shutil.which("fd")
is_fd_installed = fd_path is not None


def setup_folder(base_dir: str, structure: dict = None) -> None:
    structure = structure or {}
    dirs = structure.get("dirs", [])
    files = structure.get("files", {})

    for d in dirs:
        os.makedirs(os.path.join(base_dir, d), exist_ok=True)

    for file_path, contents in files.items():
        full_path = os.path.join(base_dir, file_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(contents)


async def get_suggestions(
    provider: CombinedAutocompleteProvider,
    lines: list[str],
    cursor_line: int,
    cursor_col: int,
    force: bool = False,
):
    controller = AbortController()
    return await provider.get_suggestions(
        lines,
        cursor_line,
        cursor_col,
        {"signal": controller.signal, "force": force},
    )


@pytest.mark.anyio
async def test_extract_path_prefix_forced_root():
    provider = CombinedAutocompleteProvider([], "/tmp")
    lines = ["hey /"]
    cursor_line = 0
    cursor_col = 5  # After the "/"

    result = await get_suggestions(provider, lines, cursor_line, cursor_col, True)
    assert result is not None
    assert result.prefix == "/"


@pytest.mark.anyio
async def test_extract_path_prefix_forced_dir():
    provider = CombinedAutocompleteProvider([], "/tmp")
    lines = ["/A"]
    cursor_line = 0
    cursor_col = 2  # After the "A"

    result = await get_suggestions(provider, lines, cursor_line, cursor_col, True)
    # Could be None if /A doesn't match anything, or have /A prefix
    if result is not None:
        assert result.prefix == "/A"


@pytest.mark.anyio
async def test_does_not_trigger_for_slash_commands():
    provider = CombinedAutocompleteProvider([], "/tmp")
    lines = ["/model"]
    cursor_line = 0
    cursor_col = 6  # After "model"

    result = await get_suggestions(provider, lines, cursor_line, cursor_col, True)
    assert result is None


@pytest.mark.anyio
async def test_triggers_for_absolute_paths_in_slash_command_args():
    provider = CombinedAutocompleteProvider([], "/tmp")
    lines = ["/command /"]
    cursor_line = 0
    cursor_col = 10  # After the second "/"

    result = await get_suggestions(provider, lines, cursor_line, cursor_col, True)
    assert result is not None
    assert result.prefix == "/"


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_returns_all_files_for_empty_at_query():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "dirs": ["src"],
                "files": {
                    "README.md": "readme",
                },
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None

        values = sorted([item.value for item in result.items])
        assert values == ["@README.md", "@src/"]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_matches_file_with_extension():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "files": {
                    "file.txt": "content",
                }
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@file.txt"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert "@file.txt" in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_filters_are_case_insensitive():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "dirs": ["src"],
                "files": {
                    "README.md": "readme",
                },
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@re"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert values == ["@README.md"]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_ranks_directories_before_files():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "dirs": ["src"],
                "files": {
                    "src.txt": "text",
                },
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@src"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        assert result.items[0].value == "@src/"
        values = [item.value for item in result.items]
        assert "@src.txt" in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_returns_nested_file_paths():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "files": {
                    "src/index.ts": "export {};\n",
                }
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@index"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert "@src/index.ts" in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_matches_deeply_nested_paths():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "files": {
                    "packages/tui/src/autocomplete.ts": "export {};",
                    "packages/ai/src/autocomplete.ts": "export {};",
                }
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@tui/src/auto"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert "@packages/tui/src/autocomplete.ts" in values
        assert "@packages/ai/src/autocomplete.ts" not in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_scopes_fuzzy_search_to_relative_directories():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    outside_dir = os.path.join(temp_dir, "outside")
    os.makedirs(base_dir)
    os.makedirs(outside_dir)

    try:
        setup_folder(
            outside_dir,
            {
                "files": {
                    "nested/alpha.ts": "export {};",
                    "nested/deeper/also-alpha.ts": "export {};",
                    "nested/deeper/zzz.ts": "export {};",
                }
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@../outside/a"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert "@../outside/nested/alpha.ts" in values
        assert "@../outside/nested/deeper/also-alpha.ts" in values
        assert "@../outside/nested/deeper/zzz.ts" not in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_quotes_paths_with_spaces_for_at_suggestions():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "dirs": ["my folder"],
                "files": {
                    "my folder/test.txt": "content",
                },
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@my"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert '@"my folder/"' in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_includes_hidden_paths_but_excludes_git():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "dirs": [".pi", ".github", ".git"],
                "files": {
                    ".pi/config.json": "{}",
                    ".github/workflows/ci.yml": "name: ci",
                    ".git/config": "[core]",
                },
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert "@.pi/" in values
        assert "@.github/" in values
        assert not any(v == "@.git" or v.startswith("@.git/") for v in values)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_follows_symlinked_directories():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    outside_dir = os.path.join(temp_dir, "outside")
    os.makedirs(base_dir)
    os.makedirs(outside_dir)

    try:
        setup_folder(
            base_dir,
            {
                "files": {
                    "dir/some_file.txt": "real",
                }
            },
        )
        setup_folder(
            outside_dir,
            {
                "files": {
                    "some_file.txt": "symlinked",
                }
            },
        )

        # Create symlink
        os.symlink(outside_dir, os.path.join(base_dir, "symlinked_dir"))

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = "@some"
        result = await get_suggestions(provider, [line], 0, len(line))
        assert result is not None
        values = [item.value for item in result.items]
        assert "@dir/some_file.txt" in values
        assert "@symlinked_dir/some_file.txt" in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_continues_autocomplete_inside_quoted_at_paths():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "files": {
                    "my folder/test.txt": "content",
                    "my folder/other.txt": "content",
                }
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = '@"my folder/"'
        result = await get_suggestions(provider, [line], 0, len(line) - 1)
        assert result is not None
        values = [item.value for item in result.items]
        assert '@"my folder/test.txt"' in values
        assert '@"my folder/other.txt"' in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
@pytest.mark.skipif(not is_fd_installed, reason="fd is not installed")
async def test_fd_applies_quoted_at_completion_without_duplicating_closing_quote():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "files": {
                    "my folder/test.txt": "content",
                }
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir, fd_path)
        line = '@"my folder/te"'
        cursor_col = len(line) - 1
        result = await get_suggestions(provider, [line], 0, cursor_col)
        assert result is not None
        item = next(
            (entry for entry in result.items if entry.value == '@"my folder/test.txt"'), None
        )
        assert item is not None

        applied = provider.apply_completion([line], 0, cursor_col, item, result.prefix)
        assert applied["lines"][0] == '@"my folder/test.txt" '
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
async def test_dotslash_path_completion():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "files": {
                    "update.sh": "#!/bin/bash",
                    "utils.ts": "export {};",
                }
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir)
        line = "./up"
        result = await get_suggestions(provider, [line], 0, len(line), True)
        assert result is not None
        values = [item.value for item in result.items]
        assert "./update.sh" in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
async def test_quoted_path_completion():
    temp_dir = tempfile.mkdtemp(prefix="pi-auto-")
    base_dir = os.path.join(temp_dir, "cwd")
    os.makedirs(base_dir)

    try:
        setup_folder(
            base_dir,
            {
                "dirs": ["my folder"],
                "files": {
                    "my folder/test.txt": "content",
                },
            },
        )

        provider = CombinedAutocompleteProvider([], base_dir)
        line = "my"
        result = await get_suggestions(provider, [line], 0, len(line), True)
        assert result is not None
        values = [item.value for item in result.items]
        assert '"my folder/"' in values
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
