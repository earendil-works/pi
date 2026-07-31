import { type ExecutionEnv, ExecutionError, err, ok, type Result, type ShellExecOptions, toError } from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

/** 命令执行过程中的实时进度数据，可通过 onChunk 回调中的 getProgress 获取。 */
export interface ShellCaptureProgress {
	output: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	lastLineBytes: number;
}

/** Shell 命令捕获选项，继承 ShellExecOptions 但移除 stdout/stderr 回调（由内部流式捕获逻辑管理）。 */
export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	onChunk?: (chunk: string, getProgress: () => ShellCaptureProgress) => void;
	/** Return shell execution failures with captured output instead of as a failed Result. */
	returnExecutionErrors?: boolean;
}

/** Shell 命令捕获的完整结果，继承进度信息并附加最终状态。 */
export interface ShellCaptureResult extends ShellCaptureProgress {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	executionError?: ExecutionError;
}

/** 将任意错误包装为 ExecutionError，已存在的 ExecutionError 实例直接返回。 */
function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}

/**
 * 过滤 shell 输出中的控制字符，防止二进制数据污染上下文。
 * 保留常见的文本控制字符：制表符（0x09）、换行符（0x0a）、回车符（0x0d），
 * 过滤其他 C0 控制字符（0x00-0x1f）以及 Unicode 行间注释字符（U+FFF9-U+FFFB）。
 * @param str - 原始输出字符串
 * @returns 过滤后的安全文本字符串
 */
export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

/** 从末尾截断文本至指定的 UTF-8 字节数，确保不截断多字节字符。 */
function trimToLastUtf8Bytes(text: string, maxBytes: number, encoder: { encode(input?: string): Uint8Array }): string {
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return new TextDecoder().decode(bytes.subarray(start));
}

/**
 * 执行 shell 命令并捕获其输出，提供二进制过滤、输出截断和溢出写盘等完整处理。
 *
 * 整个捕获流程分为三层：
 * 1. **流式捕获**：通过 env.exec 的 onStdout/onStderr 回调实时接收输出块，
 *    合并 stdout 和 stderr 为统一流，逐块进行二进制过滤和累积。
 * 2. **内存管理**：在内存中维护一个环形缓冲区（outputChunks），当输出字节数
 *    超过 maxOutputBytes（DEFAULT_MAX_BYTES * 2）时，丢弃最早的 chunk，
 *    保证内存占用不会无限增长。
 * 3. **溢出写盘**：当原始输出超过 DEFAULT_MAX_BYTES 时，延迟创建临时日志文件，
 *    通过串行化的 writeChain Promise 链将完整的原始输出追加写入磁盘。
 *    最终返回的 ShellCaptureResult.fullOutputPath 指向该文件。
 *
 * **取消处理**：当 AbortSignal 触发时，不会抛出错误，而是返回部分结果，
 * 其中 cancelled 标记为 true，exitCode 设为 undefined。
 *
 * @param env - 执行环境实例，提供 exec 和文件操作方法
 * @param command - 要执行的 shell 命令字符串
 * @param options - 可选的捕获配置，支持超时、工作目录、环境变量、中断信号等
 * @returns 包含 ShellCaptureResult 的 Result，执行失败时返回 ExecutionError
 */
export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	let tailOutput = "";
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	const encoder = new TextEncoder();

	let totalBytes = 0;
	let completedLines = 0;
	let hasOpenLine = false;
	let currentLineBytes = 0;
	let fullOutputPath: string | undefined;
	let fullOutputRequested = false;
	let acceptingOutput = true;
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	let captureError: ExecutionError | undefined;

	const appendFullOutput = (text: string): void => {
		if (!fullOutputRequested || captureError) return;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			if (!fullOutputPath) return err(new ExecutionError("unknown", "Full output path was not created"));
			const appendResult = await env.appendFile(fullOutputPath, text);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputRequested || captureError) return;
		fullOutputRequested = true;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const tempFile = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value;
			const appendResult = await env.appendFile(tempFile.value, initialContent);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const createProgress = (): ShellCaptureProgress => {
		const tailTruncation = truncateTail(tailOutput);
		const totalLines = completedLines + (hasOpenLine ? 1 : 0);
		const truncated = totalLines > DEFAULT_MAX_LINES || totalBytes > DEFAULT_MAX_BYTES;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy: truncated
				? (tailTruncation.truncatedBy ?? (totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines"))
				: null,
			totalLines,
			totalBytes,
		};
		return {
			output: truncated ? truncation.content : tailOutput,
			truncation,
			fullOutputPath,
			lastLineBytes: currentLineBytes,
		};
	};

	const onChunk = (chunk: string): void => {
		if (!acceptingOutput) return;
		try {
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			const textBytes = encoder.encode(text).byteLength;
			totalBytes += textBytes;
			const newlineCount = text.split("\n").length - 1;
			completedLines += newlineCount;
			const lastNewline = text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const trailingText = text.slice(lastNewline + 1);
				currentLineBytes = encoder.encode(trailingText).byteLength;
				hasOpenLine = trailingText.length > 0;
			} else if (text.length > 0) {
				currentLineBytes += textBytes;
				hasOpenLine = true;
			}

			tailOutput += text;
			const totalLines = completedLines + (hasOpenLine ? 1 : 0);
			if ((totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES) && !fullOutputRequested) {
				ensureFullOutputFile(tailOutput);
			} else if (fullOutputRequested) {
				appendFullOutput(text);
			}
			tailOutput = trimToLastUtf8Bytes(tailOutput, maxOutputBytes, encoder);
			options?.onChunk?.(text, createProgress);
		} catch (error) {
			captureError = toExecutionError(error);
		}
	};

	try {
		const result = await env.exec(command, {
			cwd: options?.cwd,
			env: options?.env,
			inheritEnv: options?.inheritEnv,
			timeout: options?.timeout,
			abortSignal: options?.abortSignal,
			onStdout: onChunk,
			onStderr: onChunk,
		});
		acceptingOutput = false;
		let progress = createProgress();
		if (progress.truncation.truncated && !fullOutputRequested) ensureFullOutputFile(tailOutput);
		const writeResult = await writeChain;
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);
		progress = createProgress();

		if (!result.ok) {
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				return ok({
					...progress,
					exitCode: undefined,
					cancelled: true,
					truncated: progress.truncation.truncated,
				});
			}
			if (options?.returnExecutionErrors) {
				return ok({
					...progress,
					exitCode: undefined,
					cancelled: false,
					truncated: progress.truncation.truncated,
					executionError: result.error,
				});
			}
			return err(result.error);
		}
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({
			...progress,
			exitCode: cancelled ? undefined : result.value.exitCode,
			cancelled,
			truncated: progress.truncation.truncated,
		});
	} catch (error) {
		acceptingOutput = false;
		return err(toExecutionError(error));
	}
}
