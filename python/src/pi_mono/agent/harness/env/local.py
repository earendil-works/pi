import os
import shutil
import asyncio
import tempfile
import uuid
import stat
import errno
from typing import Optional, Union, Any, cast

from pi_mono.agent.harness.types import (
    ExecutionEnv,
    ExecutionEnvExecOptions,
    ShellExecResult,
    FileInfo,
    FileKind,
    FileError,
    ExecutionError,
    Result,
    ok,
    err,
    toError,
)
from pi_mono.utils.abort_signals import AbortSignal
from pi_mono.utils.shell import get_shell_config as resolve_shell_config


def to_file_error(error: Exception, path: Optional[str] = None) -> FileError:
    if isinstance(error, FileError):
        return error

    msg = str(error)
    if isinstance(error, FileNotFoundError):
        return FileError("not_found", msg, path, error)
    if isinstance(error, PermissionError):
        return FileError("permission_denied", msg, path, error)
    if isinstance(error, NotADirectoryError):
        return FileError("not_directory", msg, path, error)
    if isinstance(error, IsADirectoryError):
        return FileError("is_directory", msg, path, error)

    if hasattr(error, "errno"):
        err_no = getattr(error, "errno")
        if err_no == errno.ENOENT:
            return FileError("not_found", msg, path, error)
        if err_no in (errno.EACCES, errno.EPERM):
            return FileError("permission_denied", msg, path, error)
        if err_no == errno.ENOTDIR:
            return FileError("not_directory", msg, path, error)
        if err_no == errno.EISDIR:
            return FileError("is_directory", msg, path, error)

    return FileError("unknown", msg, path, error)


def abort_result(
    signal: Optional[AbortSignal], path: Optional[str] = None
) -> Optional[Result[Any, FileError]]:
    return err(FileError("aborted", "aborted", path)) if signal and signal.aborted else None


def fileInfoFromStats(path: str, stats: os.stat_result) -> Result[FileInfo, FileError]:
    mode = stats.st_mode
    kind: FileKind = "file"
    if stat.S_ISLNK(mode):
        kind = "symlink"
    elif stat.S_ISDIR(mode):
        kind = "directory"
    elif stat.S_ISREG(mode):
        kind = "file"
    else:
        return err(FileError("invalid", "Unsupported file type", path))

    name = os.path.basename(path.rstrip("/\\")) or path

    return ok(
        FileInfo(
            name=name,
            path=path,
            kind=kind,
            size=stats.st_size,
            mtime_ms=int(stats.st_mtime * 1000.0),
        )
    )


async def find_bash_on_path() -> Optional[str]:
    cmd = "where" if os.name == "nt" else "which"
    args = ["bash.exe"] if os.name == "nt" else ["bash"]
    try:
        proc = await asyncio.create_subprocess_exec(
            cmd,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        if proc.returncode == 0 and stdout:
            first_match = stdout.decode("utf-8").strip().splitlines()[0]
            if os.path.exists(first_match):
                return first_match
    except Exception:
        pass
    return None


async def get_shell_config(
    custom_shell_path: Optional[str],
) -> Result[dict[str, Any], ExecutionError]:
    if custom_shell_path and not os.path.exists(custom_shell_path):
        return err(
            ExecutionError(
                "shell_unavailable",
                f"Custom shell path not found: {custom_shell_path}",
            )
        )

    try:
        return ok(resolve_shell_config(custom_shell_path))
    except (RuntimeError, ValueError) as error:
        return err(ExecutionError("shell_unavailable", str(error)))


def get_shell_env(
    base_env: Optional[dict[str, str]], extra_env: Optional[dict[str, str]]
) -> dict[str, str]:
    env = dict(os.environ)
    if base_env:
        env.update(base_env)
    if extra_env:
        env.update(extra_env)
    return env


class LocalExecutionEnv(ExecutionEnv):
    def __init__(
        self,
        cwd: str,
        shellPath: Optional[str] = None,
        shellEnv: Optional[dict[str, str]] = None,
    ) -> None:
        self.cwd = os.path.abspath(cwd)
        self.shellPath = shellPath
        self.shellEnv = shellEnv

    async def absolutePath(
        self, path: str, abortSignal: Optional[AbortSignal] = None
    ) -> Result[str, FileError]:
        return ok(os.path.abspath(os.path.join(self.cwd, path)))

    async def joinPath(
        self, parts: list[str], abortSignal: Optional[AbortSignal] = None
    ) -> Result[str, FileError]:
        return ok(os.path.join(*parts))

    async def readTextFile(
        self, path: str, abortSignal: Optional[AbortSignal] = None
    ) -> Result[str, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted
        try:
            with open(resolved, "r", encoding="utf-8") as f:
                return ok(f.read())
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def readTextLines(
        self,
        path: str,
        options: Optional[dict[str, Any]] = None,
        abortSignal: Optional[AbortSignal] = None,
    ) -> Result[list[str], FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted

        max_lines = options.get("maxLines") if options else None
        if max_lines is not None and max_lines <= 0:
            return ok([])

        try:
            lines = []
            with open(resolved, "r", encoding="utf-8") as f:
                for line in f:
                    if abortSignal and abortSignal.aborted:
                        return err(FileError("aborted", "aborted", resolved))
                    lines.append(line.rstrip("\r\n"))
                    if max_lines is not None and len(lines) >= max_lines:
                        break
            return ok(lines)
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def readBinaryFile(
        self, path: str, abortSignal: Optional[AbortSignal] = None
    ) -> Result[bytes, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted
        try:
            with open(resolved, "rb") as f:
                return ok(f.read())
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def writeFile(
        self,
        path: str,
        content: Union[str, bytes],
        abortSignal: Optional[AbortSignal] = None,
    ) -> Result[None, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted
        try:
            parent = os.path.dirname(resolved)
            os.makedirs(parent, exist_ok=True)
            if abortSignal and abortSignal.aborted:
                return err(FileError("aborted", "aborted", resolved))

            if isinstance(content, bytes):
                with open(resolved, "wb") as f:
                    f.write(content)
            else:
                with open(resolved, "w", encoding="utf-8") as f:
                    f.write(content)
            return ok(None)
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def appendFile(
        self,
        path: str,
        content: Union[str, bytes],
        abortSignal: Optional[AbortSignal] = None,
    ) -> Result[None, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted
        try:
            parent = os.path.dirname(resolved)
            os.makedirs(parent, exist_ok=True)
            if abortSignal and abortSignal.aborted:
                return err(FileError("aborted", "aborted", resolved))

            if isinstance(content, bytes):
                with open(resolved, "ab") as f:
                    f.write(content)
            else:
                with open(resolved, "a", encoding="utf-8") as f:
                    f.write(content)
            return ok(None)
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def fileInfo(
        self, path: str, abortSignal: Optional[AbortSignal] = None
    ) -> Result[FileInfo, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        try:
            return fileInfoFromStats(resolved, os.lstat(resolved))
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def listDir(
        self, path: str, abortSignal: Optional[AbortSignal] = None
    ) -> Result[list[FileInfo], FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted
        try:
            infos: list[FileInfo] = []
            for entry in os.scandir(resolved):
                if abortSignal and abortSignal.aborted:
                    return err(FileError("aborted", "aborted", resolved))
                info_res = fileInfoFromStats(entry.path, entry.stat(follow_symlinks=False))
                if info_res.ok and info_res.value is not None:
                    infos.append(info_res.value)
            return ok(infos)
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def canonicalPath(
        self, path: str, abortSignal: Optional[AbortSignal] = None
    ) -> Result[str, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        try:
            return ok(os.path.realpath(resolved))
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def exists(
        self, path: str, abortSignal: Optional[AbortSignal] = None
    ) -> Result[bool, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        try:
            os.lstat(resolved)
            return ok(True)
        except FileNotFoundError:
            return ok(False)
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def createDir(
        self,
        path: str,
        options: Optional[dict[str, Any]] = None,
        abortSignal: Optional[AbortSignal] = None,
    ) -> Result[None, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted
        recursive = options.get("recursive", True) if options else True
        try:
            if recursive:
                os.makedirs(resolved, exist_ok=True)
            else:
                os.mkdir(resolved)
            return ok(None)
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def remove(
        self,
        path: str,
        options: Optional[dict[str, Any]] = None,
        abortSignal: Optional[AbortSignal] = None,
    ) -> Result[None, FileError]:
        resolved = os.path.abspath(os.path.join(self.cwd, path))
        aborted = abort_result(abortSignal, resolved)
        if aborted:
            return aborted
        recursive = options.get("recursive", False) if options else False
        force = options.get("force", False) if options else False

        try:
            if recursive:
                if os.path.isdir(resolved) and not os.path.islink(resolved):
                    try:
                        shutil.rmtree(resolved)
                    except FileNotFoundError:
                        if not force:
                            raise
                else:
                    try:
                        os.remove(resolved)
                    except FileNotFoundError:
                        if not force:
                            raise
            else:
                if os.path.isdir(resolved) and not os.path.islink(resolved):
                    os.rmdir(resolved)
                else:
                    try:
                        os.remove(resolved)
                    except FileNotFoundError:
                        if not force:
                            raise
            return ok(None)
        except Exception as e:
            return err(to_file_error(e, resolved))

    async def createTempDir(
        self, prefix: Optional[str] = None, abortSignal: Optional[AbortSignal] = None
    ) -> Result[str, FileError]:
        aborted = abort_result(abortSignal)
        if aborted:
            return aborted
        try:
            pref = prefix if prefix is not None else "tmp-"
            path = tempfile.mkdtemp(prefix=pref)
            return ok(path)
        except Exception as e:
            return err(to_file_error(e))

    async def createTempFile(
        self,
        options: Optional[dict[str, Any]] = None,
        abortSignal: Optional[AbortSignal] = None,
    ) -> Result[str, FileError]:
        aborted = abort_result(abortSignal)
        if aborted:
            return aborted
        try:
            dir_res = await self.createTempDir("tmp-", abortSignal)
            if dir_res.value is None:
                return err(FileError("unknown", "Temp directory path is None"))
            prefix = options.get("prefix", "") if options else ""
            suffix = options.get("suffix", "") if options else ""
            filePath = os.path.join(dir_res.value, f"{prefix}{uuid.uuid4()}{suffix}")
            with open(filePath, "w", encoding="utf-8"):
                pass
            return ok(filePath)
        except Exception as e:
            return err(to_file_error(e))

    async def exec(
        self,
        command: str,
        options: Optional[ExecutionEnvExecOptions] = None,
    ) -> Result[ShellExecResult, ExecutionError]:
        abort_signal = options.get("abortSignal") if options else None
        if abort_signal and abort_signal.aborted:
            return err(ExecutionError("aborted", "aborted"))

        cwd = options.get("cwd") if options else None
        cwd = os.path.abspath(os.path.join(self.cwd, cwd)) if cwd else self.cwd

        shell_res = await get_shell_config(self.shellPath)
        if not shell_res.ok:
            return cast(Result[ShellExecResult, ExecutionError], shell_res)

        val = shell_res.value
        if val is None:
            return err(ExecutionError("unknown", "Shell configuration is empty"))
        shell = val["shell"]
        shell_args = val["args"]
        command_transport = val.get("commandTransport")
        command_from_stdin = command_transport == "stdin"
        spawn_args = list(shell_args) if command_from_stdin else list(shell_args) + [command]
        env_dict = get_shell_env(self.shellEnv, options.get("env") if options else None)

        timed_out = False
        callback_error = None
        proc = None

        def kill_proc() -> None:
            nonlocal proc
            if proc and proc.returncode is None:
                if os.name == "nt":
                    import subprocess

                    try:
                        subprocess.run(
                            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                        )
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                else:
                    import signal

                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass

        def on_abort() -> None:
            kill_proc()

        if abort_signal:
            if abort_signal.aborted:
                on_abort()
            else:
                abort_signal.add_event_listener("abort", on_abort, once=True)

        try:
            kwargs: dict[str, Any] = {}
            if os.name != "nt":
                kwargs["start_new_session"] = True

            proc = await asyncio.create_subprocess_exec(
                shell,
                *spawn_args,
                cwd=cwd,
                env=env_dict,
                stdin=asyncio.subprocess.PIPE if command_from_stdin else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **kwargs,
            )
            if command_from_stdin and proc.stdin is not None:
                proc.stdin.write(command.encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()
        except Exception as e:
            if abort_signal:
                abort_signal.remove_event_listener("abort", on_abort)
            cause = toError(e)
            return err(ExecutionError("spawn_error", str(cause), cause))

        stdout_acc: list[str] = []
        stderr_acc: list[str] = []

        async def read_stream(
            reader: Any, callback: Any, accumulator: list[str], is_stderr: bool
        ) -> None:
            nonlocal callback_error
            while True:
                try:
                    chunk = await reader.read(65536)
                    if not chunk:
                        break
                    decoded = chunk.decode("utf-8", errors="replace")
                    accumulator.append(decoded)
                    if callback:
                        try:
                            callback(decoded)
                        except Exception as cb_err:
                            cause = toError(cb_err)
                            callback_error = ExecutionError("callback_error", str(cause), cause)
                            kill_proc()
                            break
                except Exception:
                    break

        on_stdout = options.get("onStdout") if options else None
        on_stderr = options.get("onStderr") if options else None

        stdout_task = asyncio.create_task(read_stream(proc.stdout, on_stdout, stdout_acc, False))
        stderr_task = asyncio.create_task(read_stream(proc.stderr, on_stderr, stderr_acc, True))

        timeout = options.get("timeout") if options else None

        try:
            if timeout is not None:
                try:
                    returncode = await asyncio.wait_for(proc.wait(), timeout=timeout)
                except asyncio.TimeoutError:
                    timed_out = True
                    kill_proc()
                    returncode = await proc.wait()
            else:
                returncode = await proc.wait()
        except Exception:
            kill_proc()
            returncode = await proc.wait()

        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

        if abort_signal:
            abort_signal.remove_event_listener("abort", on_abort)

        if callback_error:
            return err(callback_error)

        if timed_out:
            return err(ExecutionError("timeout", f"timeout:{timeout}"))

        if abort_signal and abort_signal.aborted:
            return err(ExecutionError("aborted", "aborted"))

        stdout_str = "".join(stdout_acc)
        stderr_str = "".join(stderr_acc)

        return ok(
            {
                "stdout": stdout_str,
                "stderr": stderr_str,
                "exitCode": returncode if returncode is not None else 0,
            }
        )

    # Snake_case aliases to implement the FileSystem interface
    absolute_path = absolutePath
    join_path = joinPath
    read_text_file = readTextFile
    read_text_lines = readTextLines
    read_binary_file = readBinaryFile
    write_file = writeFile
    append_file = appendFile
    file_info = fileInfo
    list_dir = listDir
    canonical_path = canonicalPath
    create_dir = createDir
    create_temp_dir = createTempDir
    create_temp_file = createTempFile

    async def cleanup(self) -> None:
        pass
