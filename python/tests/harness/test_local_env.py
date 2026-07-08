import os
import pytest
from pi_mono.agent.harness.env.local import LocalExecutionEnv
from pi_mono.agent.harness.types import get_or_throw, FileError
from pi_mono.utils.abort_signals import AbortController
from pi_mono.agent.harness.utils.shell_output import executeShellWithCapture
from tests.harness.session_test_utils import createTempDir, cleanupTempDirs


chmodRestorePaths = []


@pytest.fixture(autouse=True)
def run_around_tests():
    yield
    cleanupTempDirs()
    for path in chmodRestorePaths:
        try:
            if os.path.exists(path):
                os.chmod(path, 0o700)
        except Exception:
            pass
    chmodRestorePaths.clear()


@pytest.mark.anyio
async def test_reads_writes_lists_and_removes_files_and_directories():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    assert get_or_throw(await env.absolute_path("nested/child")) == os.path.join(
        root, "nested/child"
    )
    assert get_or_throw(await env.join_path([root, "nested", "child"])) == os.path.join(
        root, "nested", "child"
    )

    get_or_throw(await env.create_dir("nested/child"))
    get_or_throw(await env.write_file("nested/child/file.txt", "hel"))
    get_or_throw(await env.append_file("nested/child/file.txt", "lo"))
    assert get_or_throw(await env.read_text_file("nested/child/file.txt")) == "hello"
    assert get_or_throw(await env.read_text_lines("nested/child/file.txt", {"maxLines": 1})) == [
        "hello"
    ]
    assert (
        get_or_throw(await env.read_binary_file("nested/child/file.txt")).decode("utf-8") == "hello"
    )

    entries = get_or_throw(await env.list_dir("nested/child"))
    assert len(entries) == 1
    assert entries[0].name == "file.txt"
    assert entries[0].path == os.path.join(root, "nested/child/file.txt")
    assert entries[0].kind == "file"
    assert entries[0].size == 5
    assert isinstance(entries[0].mtime_ms, (int, float))

    assert get_or_throw(await env.exists("nested/child/file.txt")) is True
    get_or_throw(await env.remove("nested/child/file.txt"))
    assert get_or_throw(await env.exists("nested/child/file.txt")) is False


@pytest.mark.anyio
async def test_returns_file_info_for_files_directories_and_symlinks_without_following_symlinks():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    get_or_throw(await env.create_dir("dir", {"recursive": True}))
    get_or_throw(await env.write_file("dir/file.txt", "hello"))
    os.symlink(os.path.join(root, "dir/file.txt"), os.path.join(root, "file-link"))
    os.symlink(os.path.join(root, "dir"), os.path.join(root, "dir-link"))

    info_dir = get_or_throw(await env.file_info("dir"))
    assert info_dir.name == "dir"
    assert info_dir.path == os.path.join(root, "dir")
    assert info_dir.kind == "directory"

    info_file = get_or_throw(await env.file_info("dir/file.txt"))
    assert info_file.name == "file.txt"
    assert info_file.path == os.path.join(root, "dir/file.txt")
    assert info_file.kind == "file"
    assert info_file.size == 5

    info_link = get_or_throw(await env.file_info("file-link"))
    assert info_link.name == "file-link"
    assert info_link.path == os.path.join(root, "file-link")
    assert info_link.kind == "symlink"

    info_dir_link = get_or_throw(await env.file_info("dir-link"))
    assert info_dir_link.name == "dir-link"
    assert info_dir_link.path == os.path.join(root, "dir-link")
    assert info_dir_link.kind == "symlink"

    assert get_or_throw(await env.canonical_path("file-link")) == os.path.realpath(
        os.path.join(root, "dir/file.txt")
    )


@pytest.mark.anyio
async def test_lists_symlinks_as_symlinks():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    get_or_throw(await env.write_file("target.txt", "hello"))
    os.symlink(os.path.join(root, "target.txt"), os.path.join(root, "link.txt"))

    entries = get_or_throw(await env.list_dir("."))
    sorted_entries = sorted(
        [{"name": e.name, "kind": e.kind} for e in entries], key=lambda x: x["name"]
    )
    assert sorted_entries == [
        {"name": "link.txt", "kind": "symlink"},
        {"name": "target.txt", "kind": "file"},
    ]


@pytest.mark.anyio
async def test_stops_reading_text_lines_at_requested_limit():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    get_or_throw(await env.write_file("file.txt", "one\ntwo\nthree"))
    assert get_or_throw(await env.read_text_lines("file.txt", {"maxLines": 1})) == ["one"]


@pytest.mark.anyio
async def test_returns_file_error_for_missing_paths_keeps_exists_false():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    info = await env.file_info("missing.txt")
    assert info.ok is False
    assert isinstance(info.error, FileError)
    assert info.error.code == "not_found"
    assert info.error.path == os.path.join(root, "missing.txt")
    assert get_or_throw(await env.exists("missing.txt")) is False


@pytest.mark.anyio
async def test_returns_file_error_for_listing_non_directories():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    get_or_throw(await env.write_file("file.txt", "hello"))
    result = await env.list_dir("file.txt")
    assert result.ok is False
    assert isinstance(result.error, FileError)
    assert result.error.code == "not_directory"


@pytest.mark.anyio
async def test_appends_to_new_files_creates_parent_directories():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    get_or_throw(await env.append_file("new/nested/file.txt", "a"))
    get_or_throw(await env.append_file("new/nested/file.txt", "b"))
    assert get_or_throw(await env.read_text_file("new/nested/file.txt")) == "ab"


@pytest.mark.anyio
async def test_creates_temporary_directories_and_files():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    tempDir = get_or_throw(await env.create_temp_dir("node-env-test-"))
    assert os.path.exists(tempDir)
    tempFile = get_or_throw(await env.create_temp_file({"prefix": "prefix-", "suffix": ".txt"}))
    assert os.path.exists(tempFile)
    assert tempFile.endswith(".txt")


@pytest.mark.anyio
async def test_honors_create_dir_recursive_false_and_remove_options():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    createResult = await env.create_dir("missing/child", {"recursive": False})
    assert createResult.ok is False
    assert createResult.error.code == "not_found"

    get_or_throw(await env.write_file("dir/child/file.txt", "hello"))
    removeDirectory = await env.remove("dir", {"recursive": False})
    assert removeDirectory.ok is False

    get_or_throw(await env.remove("dir", {"recursive": True}))
    assert get_or_throw(await env.exists("dir")) is False

    removeMissing = await env.remove("missing", {"force": False})
    assert removeMissing.ok is False
    get_or_throw(await env.remove("missing", {"force": True}))


@pytest.mark.anyio
async def test_returns_aborted_results_for_pre_aborted_operations():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    get_or_throw(await env.write_file("file.txt", "hello"))
    controller = AbortController()
    controller.abort()
    signal = controller.signal

    results = [
        await env.read_text_file("file.txt", signal),
        await env.read_text_lines("file.txt", abortSignal=signal),
        await env.read_binary_file("file.txt", signal),
        await env.write_file("other.txt", "hello", signal),
        await env.list_dir(".", signal),
    ]
    for result in results:
        assert result.ok is False
        assert result.error.code == "aborted"


@pytest.mark.anyio
async def test_executes_commands_in_cwd_with_env_overrides():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    result = get_or_throw(
        await env.exec(
            'printf "%s:%s" "$PWD" "$NODE_ENV_TEST"',
            {
                "env": {"NODE_ENV_TEST": "ok"},
            },
        )
    )
    assert result == {"stdout": f"{os.path.realpath(root)}:ok", "stderr": "", "exitCode": 0}


@pytest.mark.anyio
async def test_streams_stdout_and_stderr_chunks():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    stdout = []
    stderr = []
    result = get_or_throw(
        await env.exec(
            "printf out; printf err >&2",
            {
                "onStdout": lambda chunk: stdout.append(chunk),
                "onStderr": lambda chunk: stderr.append(chunk),
            },
        )
    )
    assert result == {"stdout": "out", "stderr": "err", "exitCode": 0}
    assert "".join(stdout) == "out"
    assert "".join(stderr) == "err"


@pytest.mark.anyio
async def test_returns_non_zero_exit_codes_as_success():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    result = get_or_throw(await env.exec("exit 7"))
    assert result == {"stdout": "", "stderr": "", "exitCode": 7}


@pytest.mark.anyio
async def test_returns_timeout_errors():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    result = await env.exec("sleep 5", {"timeout": 0.01})
    assert result.ok is False
    assert result.error.code == "timeout"


@pytest.mark.anyio
async def test_returns_callback_errors():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)

    def raise_err(chunk):
        raise Exception("callback failed")

    result = await env.exec(
        "printf out",
        {
            "onStdout": raise_err,
        },
    )
    assert result.ok is False
    assert result.error.code == "callback_error"
    assert "callback failed" in result.error.message


@pytest.mark.anyio
async def test_returns_shell_unavailable_and_spawn_errors():
    root = createTempDir()
    missingShellEnv = LocalExecutionEnv(cwd=root, shellPath=os.path.join(root, "missing-shell"))
    missingShell = await missingShellEnv.exec("printf ok")
    assert missingShell.ok is False
    assert missingShell.error.code == "shell_unavailable"

    shellPath = os.path.join(root, "not-executable-shell")
    env = LocalExecutionEnv(cwd=root)
    get_or_throw(await env.write_file(shellPath, "not executable"))
    # Make file not executable
    os.chmod(shellPath, 0o400)
    chmodRestorePaths.append(shellPath)

    spawnErrorEnv = LocalExecutionEnv(cwd=root, shellPath=shellPath)
    spawnError = await spawnErrorEnv.exec("printf ok")
    assert spawnError.ok is False
    assert spawnError.error.code == "spawn_error"


@pytest.mark.anyio
async def test_returns_aborted_result_for_aborted_commands():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    controller = AbortController()
    promise = env.exec("sleep 5", {"abortSignal": controller.signal})
    controller.abort()
    result = await promise
    assert result.ok is False
    assert result.error.code == "aborted"


@pytest.mark.anyio
async def test_captures_large_shell_output_to_full_output_file():
    root = createTempDir()
    env = LocalExecutionEnv(cwd=root)
    result = get_or_throw(await executeShellWithCapture(env, "yes line | head -n 15000"))
    assert result["truncated"] is True
    assert result["fullOutputPath"] is not None
    fullOutput = get_or_throw(await env.read_text_file(result["fullOutputPath"]))
    assert len(fullOutput.split("\n")) > 10000
    assert len(result["output"]) < len(fullOutput)
