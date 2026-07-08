import asyncio
from typing import Any, Callable, Optional, TypedDict

from pi_mono.agent.harness.types import (
    ExecutionEnv,
    ExecutionEnvExecOptions,
    ExecutionError,
    Result,
    ok,
    err,
    toError,
)
from pi_mono.agent.harness.utils.truncate import DEFAULT_MAX_BYTES, truncateTail


class ShellCaptureOptions(TypedDict, total=False):
    cwd: str
    env: dict[str, str]
    timeout: float
    abortSignal: Optional[Any]
    onChunk: Optional[Callable[[str], None]]


class ShellCaptureResult(TypedDict, total=False):
    output: str
    exitCode: Optional[int]
    cancelled: bool
    truncated: bool
    fullOutputPath: str


def toExecutionError(error: Exception) -> ExecutionError:
    if isinstance(error, ExecutionError):
        return error
    cause = toError(error)
    return ExecutionError("unknown", str(cause), cause)


def sanitizeBinaryOutput(s: str) -> str:
    parts = []
    for char in s:
        code = ord(char)
        if code in (0x09, 0x0A, 0x0D):
            parts.append(char)
        elif code <= 0x1F:
            continue
        elif 0xFFF9 <= code <= 0xFFFB:
            continue
        else:
            parts.append(char)
    return "".join(parts)


async def executeShellWithCapture(
    env: ExecutionEnv,
    command: str,
    options: Optional[ShellCaptureOptions] = None,
) -> Result[ShellCaptureResult, ExecutionError]:
    outputChunks: list[str] = []
    outputBytes = 0
    maxOutputBytes = DEFAULT_MAX_BYTES * 2

    totalBytes = 0
    fullOutputPath: Optional[str] = None
    captureError: Optional[ExecutionError] = None
    write_lock = asyncio.Lock()

    async def appendFullOutput(text: str) -> None:
        nonlocal captureError
        if not fullOutputPath or captureError:
            return
        async with write_lock:
            appendResult = await env.appendFile(
                fullOutputPath,
                text,
                options.get("abortSignal") if options else None,
            )
            if not appendResult.ok:
                err_val = appendResult.error or Exception("Append failed")
                captureError = toExecutionError(err_val)

    async def ensureFullOutputFile(initialContent: str) -> None:
        nonlocal fullOutputPath, captureError
        if fullOutputPath or captureError:
            return
        async with write_lock:
            tempFile = await env.createTempFile(
                {
                    "prefix": "bash-",
                    "suffix": ".log",
                    "abortSignal": options.get("abortSignal") if options else None,
                }
            )
            if not tempFile.ok:
                err_val = tempFile.error or Exception("Temp file creation failed")
                captureError = toExecutionError(err_val)
                return
            if tempFile.value is None:
                captureError = toExecutionError(Exception("Temp file path is None"))
                return
            fullOutputPath = tempFile.value
            appendResult = await env.appendFile(
                tempFile.value,
                initialContent,
                options.get("abortSignal") if options else None,
            )
            if not appendResult.ok:
                err_val = appendResult.error or Exception("Append failed")
                captureError = toExecutionError(err_val)

    def onChunk(chunk: str) -> None:
        nonlocal totalBytes, outputBytes, captureError
        try:
            totalBytes += len(chunk.encode("utf-8"))
            text = sanitizeBinaryOutput(chunk).replace("\r", "")
            if totalBytes > DEFAULT_MAX_BYTES and not fullOutputPath:
                # We need to ensure temp file creation asynchronously,
                # but we are in a sync callback. We can schedule it:
                asyncio.create_task(ensureFullOutputFile("".join(outputChunks) + text))
            else:
                if fullOutputPath:
                    asyncio.create_task(appendFullOutput(text))
            outputChunks.append(text)
            outputBytes += len(text)
            while outputBytes > maxOutputBytes and len(outputChunks) > 1:
                removed = outputChunks.pop(0)
                outputBytes -= len(removed)
            if options:
                on_chunk_fn = options.get("onChunk")
                if on_chunk_fn is not None:
                    on_chunk_fn(text)
        except Exception as error:
            captureError = toExecutionError(error)

    try:
        exec_options: ExecutionEnvExecOptions = {}
        if options:
            if "cwd" in options:
                exec_options["cwd"] = options["cwd"]
            if "env" in options:
                exec_options["env"] = options["env"]
            if "timeout" in options:
                exec_options["timeout"] = options["timeout"]
            if "abortSignal" in options:
                exec_options["abortSignal"] = options["abortSignal"]

        exec_options["onStdout"] = onChunk
        exec_options["onStderr"] = onChunk

        result = await env.exec(command, exec_options)
        tailOutput = "".join(outputChunks)
        truncationResult = truncateTail(tailOutput)
        if truncationResult["truncated"] and not fullOutputPath:
            await ensureFullOutputFile(tailOutput)

        # Wait for all scheduled writes to finish
        async with write_lock:
            pass

        if captureError:
            return err(captureError)

        abort_signal = options.get("abortSignal") if options else None
        cancelled = abort_signal.aborted if abort_signal else False

        if not result.ok:
            res_err = result.error
            if res_err is not None and (res_err.code == "aborted" or cancelled):
                res: ShellCaptureResult = {
                    "output": (
                        truncationResult["content"] if truncationResult["truncated"] else tailOutput
                    ),
                    "exitCode": None,
                    "cancelled": True,
                    "truncated": truncationResult["truncated"],
                }
                if fullOutputPath:
                    res["fullOutputPath"] = fullOutputPath
                return ok(res)
            fallback_err = result.error or ExecutionError("unknown", "Execution failed")
            return err(fallback_err)

        val = result.value
        exit_code = None if (cancelled or val is None) else val["exitCode"]
        res = {
            "output": (
                truncationResult["content"] if truncationResult["truncated"] else tailOutput
            ),
            "exitCode": exit_code,
            "cancelled": cancelled,
            "truncated": truncationResult["truncated"],
        }
        if fullOutputPath:
            res["fullOutputPath"] = fullOutputPath
        return ok(res)
    except Exception as error:
        return err(toExecutionError(error))
