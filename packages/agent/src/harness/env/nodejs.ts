import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, type WriteStream } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Context } from "../context.ts";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	toError,
} from "../types.ts";
import { OutputCapture } from "../utils/output-capture.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_STDIO_GRACE_MS = 100;
const SPILL_HIGH_WATER_MARK = 8 * 1024 * 1024;

type SpillChunk = string | Uint8Array;

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: basename(path),
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const nodeError = isNodeError(error) ? error : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		const message = nodeError.message;
		switch (nodeError.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

function waitForChildProcess(
	child: ChildProcess,
	spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise({ code: exitCode, signal: exitSignal });
		};
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => {
				if (spillIsDraining()) armIdleTimer();
				else finalize();
			}, EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
			exitCode = code;
			exitSignal = signal;
			finalize();
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	private activeChildPids = new Set<number>();

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		return await new Promise((resolvePromise) => {
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let spillError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const spillPrefix: SpillChunk[] = [];
			let spillPath: string | undefined;
			const spillQueue: SpillChunk[] = [];
			let spillStart: Promise<void> | undefined;
			let spillStream: WriteStream | undefined;
			let spillBackpressured = false;

			const onAbort = () => {
				if (child?.pid) killProcessTree(child.pid);
			};
			const failCallback = (error: unknown) => {
				if (callbackError !== undefined) return;
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				onAbort();
			};
			let capture: OutputCapture;
			try {
				capture = new OutputCapture(options?.capture, context, {
					onUpdate: options?.onUpdate,
					onError: failCallback,
				});
			} catch (error) {
				const cause = toError(error);
				resolvePromise(err(new ExecutionError("unknown", cause.message, cause)));
				return;
			}

			const settle = (result: Result<ShellExecResult, ExecutionError>) => {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				if (signal) signal.removeEventListener("abort", onAbort);
				if (child?.pid) this.activeChildPids.delete(child.pid);
				capture.dispose();
				resolvePromise(result);
			};
			const pauseOutput = () => {
				child?.stdout?.pause();
				child?.stderr?.pause();
			};
			const resumeOutput = () => {
				if (callbackError || spillError || timedOut || signal?.aborted || spillBackpressured) return;
				child?.stdout?.resume();
				child?.stderr?.resume();
			};
			const failSpill = (error: unknown) => {
				if (spillError !== undefined) return;
				const cause = toError(error);
				spillError = new ExecutionError(
					"unknown",
					`Failed to preserve complete shell output: ${cause.message}`,
					cause,
				);
				spillBackpressured = false;
				onAbort();
			};
			const writeSpill = (chunk: SpillChunk): void => {
				if (spillStream === undefined || chunk.length === 0) return;
				if (spillStream.write(chunk) || spillBackpressured) return;
				spillBackpressured = true;
				pauseOutput();
				spillStream.once("drain", () => {
					spillBackpressured = false;
					resumeOutput();
				});
			};
			const startSpill = (chunk: SpillChunk): void => {
				if (spillStream !== undefined) {
					writeSpill(chunk);
					return;
				}
				spillQueue.push(chunk);
				if (spillStart !== undefined) return;
				pauseOutput();
				spillStart = (async () => {
					const created = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
					if (!created.ok) throw created.error;
					spillPath = created.value;
					capture.setSpillPath(spillPath);
					spillStream = createWriteStream(spillPath, { flags: "a", highWaterMark: SPILL_HIGH_WATER_MARK });
					spillStream.on("error", failSpill);
					for (const queued of spillQueue) writeSpill(queued);
					spillQueue.length = 0;
				})()
					.catch(failSpill)
					.finally(resumeOutput);
			};
			const finishSpill = async (): Promise<void> => {
				await spillStart;
				const stream = spillStream;
				if (stream === undefined || spillError !== undefined || stream.destroyed) return;
				await new Promise<void>((resolveFinish) => {
					stream.once("error", () => resolveFinish());
					stream.once("finish", resolveFinish);
					stream.end();
				});
			};

			try {
				const commandFromStdin = shellConfig.value.commandTransport === "stdin";
				child = spawn(
					shellConfig.value.shell,
					commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						detached: process.platform !== "win32",
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				if (child.pid) this.activeChildPids.add(child.pid);
				if (commandFromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
			} catch (error) {
				const cause = toError(error);
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			timeoutId =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							onAbort();
						}, timeoutMs);

			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			const feed = (chunk: Uint8Array) => {
				try {
					const wasTruncated = capture.truncated;
					capture.push(chunk);
					if (!options?.capture?.spill || chunk.length === 0) return;
					if (spillPath !== undefined || wasTruncated) {
						startSpill(chunk);
					} else if (capture.truncated) {
						for (const prefix of spillPrefix) startSpill(prefix);
						spillPrefix.length = 0;
						startSpill(chunk);
					} else {
						spillPrefix.push(chunk);
					}
				} catch (error) {
					failCallback(error);
				}
			};
			child.stdout?.on("data", feed);
			child.stderr?.on("data", feed);

			void waitForChildProcess(
				child,
				() =>
					spillError === undefined &&
					spillStart !== undefined &&
					(spillStream === undefined || spillBackpressured),
			).then(
				async ({ code, signal: exitSignal }) => {
					await finishSpill();
					try {
						capture.finish();
						capture.flush();
					} catch (error) {
						failCallback(error);
					}
					if (callbackError) {
						settle(err(callbackError));
						return;
					}
					if (timedOut) {
						settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
						return;
					}
					if (signal?.aborted) {
						settle(err(new ExecutionError("aborted", "aborted")));
						return;
					}
					if (spillError) {
						settle(err(spillError));
						return;
					}
					const output = capture.snapshot();
					// A process killed by a signal (e.g. OOM killer) has no exit code; map it
					// to the conventional 128 + signal number so callers do not mistake it
					// for a successful exit.
					const exitCode = code ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1);
					settle(
						ok({
							exitCode,
							truncation: output.truncation,
							...(output.spillPath === undefined ? {} : { spillPath: output.spillPath }),
							...(output.lastLineBytes === undefined ? {} : { lastLineBytes: output.lastLineBytes }),
						}),
					);
				},
				(error: Error) => settle(err(new ExecutionError("spawn_error", error.message, error))),
			);
		});
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<string>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<string[]>(signal, resolved);
		if (aborted) return aborted;
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		let stream: ReturnType<typeof createReadStream> | undefined;
		let lineReader: ReturnType<typeof createInterface> | undefined;
		try {
			stream = createReadStream(resolved, { encoding: "utf8", signal });
			lineReader = createInterface({ input: stream, crlfDelay: Infinity });
			const lines: string[] = [];
			for await (const line of lineReader) {
				const loopAbort = abortResult<string[]>(signal, resolved);
				if (loopAbort) return loopAbort;
				lines.push(line);
				if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
			}
			const afterReadAbort = abortResult<string[]>(signal, resolved);
			if (afterReadAbort) return afterReadAbort;
			return ok(lines);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			lineReader?.close();
			stream?.destroy();
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<Uint8Array>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await appendFile(resolved, content);
			const afterAppendAbort = abortResult<void>(signal, resolved);
			return afterAppendAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = resolvePath(this.cwd, sourcePath);
		const destination = resolvePath(this.cwd, destinationPath);
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await rename(source, destination);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<FileInfo[]>(signal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(signal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			prefix ??= "tmp-";
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async cleanup(_context: Context): Promise<void> {
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}
