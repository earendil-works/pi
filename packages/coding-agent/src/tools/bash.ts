import { type AgentTool, StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { createWriteStream, existsSync, unlink, type WriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { getToolDescription } from "../prompts/index.js";

const MAX_OUTPUT_BYTES = 32 * 1024; // 32KB
const MAX_LOG_FILE_BYTES = 100 * 1024 * 1024; // 100MB - prevent disk exhaustion
const MAX_BACKGROUND_OUTPUT_CHARS = 8 * 1024;

export type BackgroundJobStatus = "running" | "exited" | "killed" | "failed";
export type BackgroundJobReason = "explicit_background" | "timeout_promoted";
type BackgroundJobAction = "status" | "wait" | "kill";

export interface BackgroundJobSnapshot {
	id: string;
	pid: number;
	command: string;
	reason: BackgroundJobReason;
	startedAt: number;
	endedAt?: number;
	status: BackgroundJobStatus;
	exitCode?: number;
	recentOutput: string;
	recentStdout: string;
	recentStderr: string;
}

interface BackgroundJobState extends BackgroundJobSnapshot {
	stdoutDecoder: StringDecoder;
	stderrDecoder: StringDecoder;
	child: ReturnType<typeof spawn>;
}

const backgroundJobs = new Map<string, BackgroundJobState>();

function trimRecentOutput(text: string): string {
	if (text.length <= MAX_BACKGROUND_OUTPUT_CHARS) {
		return text;
	}

	const trimStart = text.length - MAX_BACKGROUND_OUTPUT_CHARS;
	const newlineIndex = text.indexOf("\n", trimStart);
	const cutPoint = newlineIndex !== -1 ? newlineIndex + 1 : trimStart;
	return text.slice(cutPoint);
}

function appendBackgroundOutput(
	job: BackgroundJobState,
	key: "recentOutput" | "recentStdout" | "recentStderr",
	chunk: string,
): void {
	job[key] = trimRecentOutput(job[key] + chunk);
}

function snapshotBackgroundJob(job: BackgroundJobState): BackgroundJobSnapshot {
	const { stdoutDecoder: _stdoutDecoder, stderrDecoder: _stderrDecoder, child: _child, ...snapshot } = job;
	return { ...snapshot };
}

export function listBackgroundJobs(): BackgroundJobSnapshot[] {
	return [...backgroundJobs.values()]
		.map((job) => snapshotBackgroundJob(job))
		.sort((left, right) => right.startedAt - left.startedAt);
}

export function getBackgroundJob(id: string): BackgroundJobSnapshot | undefined {
	const job = backgroundJobs.get(id);
	if (!job) {
		return undefined;
	}
	return snapshotBackgroundJob(job);
}

export function killBackgroundJob(id: string): boolean {
	const job = backgroundJobs.get(id);
	if (!job) {
		return false;
	}
	job.status = "killed";
	job.endedAt = Date.now();
	killProcessTree(job.pid);
	return true;
}

export function killAllBackgroundJobs(): number {
	const runningJobs = [...backgroundJobs.values()].filter((job) => job.status === "running");
	for (const job of runningJobs) {
		job.status = "killed";
		job.endedAt = Date.now();
		killProcessTree(job.pid);
	}
	return runningJobs.length;
}

function registerBackgroundJob(
	command: string,
	child: ReturnType<typeof spawn>,
	options?: { startedAt?: number; initialOutput?: string; reason?: BackgroundJobReason },
): BackgroundJobSnapshot {
	const startedAt = options?.startedAt ?? Date.now();
	const id = Math.random().toString(36).slice(2, 10);
	const pid = child.pid ?? -1;
	const job: BackgroundJobState = {
		id,
		pid,
		command,
		reason: options?.reason ?? "explicit_background",
		startedAt,
		status: "running",
		recentOutput: trimRecentOutput(options?.initialOutput ?? ""),
		recentStdout: "",
		recentStderr: "",
		stdoutDecoder: new StringDecoder("utf8"),
		stderrDecoder: new StringDecoder("utf8"),
		child,
	};
	backgroundJobs.set(id, job);

	child.on("error", (error) => {
		job.status = "failed";
		job.endedAt = Date.now();
		appendBackgroundOutput(job, "recentStderr", String(error));
		appendBackgroundOutput(job, "recentOutput", String(error));
	});

	child.stdout?.on("data", (data: Buffer) => {
		const text = job.stdoutDecoder.write(data);
		if (!text) {
			return;
		}
		appendBackgroundOutput(job, "recentStdout", text);
		appendBackgroundOutput(job, "recentOutput", text);
	});

	child.stderr?.on("data", (data: Buffer) => {
		const text = job.stderrDecoder.write(data);
		if (!text) {
			return;
		}
		appendBackgroundOutput(job, "recentStderr", text);
		appendBackgroundOutput(job, "recentOutput", text);
	});

	child.on("close", (code) => {
		const stdoutTail = job.stdoutDecoder.end();
		if (stdoutTail) {
			appendBackgroundOutput(job, "recentStdout", stdoutTail);
			appendBackgroundOutput(job, "recentOutput", stdoutTail);
		}
		const stderrTail = job.stderrDecoder.end();
		if (stderrTail) {
			appendBackgroundOutput(job, "recentStderr", stderrTail);
			appendBackgroundOutput(job, "recentOutput", stderrTail);
		}
		job.endedAt = Date.now();
		job.exitCode = code ?? undefined;
		if (job.status !== "killed") {
			job.status = code === 0 ? "exited" : "failed";
		}
	});

	return (
		getBackgroundJob(id) ?? {
			id,
			pid,
			command,
			reason: options?.reason ?? "explicit_background",
			startedAt,
			status: "running",
			recentOutput: trimRecentOutput(options?.initialOutput ?? ""),
			recentStdout: "",
			recentStderr: "",
		}
	);
}

function startBackgroundJob(command: string): BackgroundJobSnapshot {
	const { shell, args } = getShellConfig();
	const child = spawn(shell, [...args, command], {
		detached: true,
		env: buildBashEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	return registerBackgroundJob(command, child, { reason: "explicit_background" });
}

function buildBackgroundJobHelpText(jobId: string): string {
	return [
		`Use ${JSON.stringify({ job: jobId, action: "status" })} to check progress.`,
		`Use ${JSON.stringify({ job: jobId, action: "wait", timeout: 30 })} to wait for the final result when completion matters.`,
	].join(" ");
}

function buildBackgroundJobResult(job: BackgroundJobSnapshot): {
	content: Array<{ type: "text"; text: string }>;
	details: { backgroundJob: BackgroundJobSnapshot };
} {
	const text =
		job.reason === "timeout_promoted"
			? [
					`Command exceeded timeout and was moved to background as job ${job.id} (pid ${job.pid}).`,
					"This preserves in-progress work instead of killing the process.",
					"The command is still running. This is not a completed result.",
					"Do not report success yet.",
					buildBackgroundJobHelpText(job.id),
				].join(" ")
			: [
					`Started background job ${job.id} (pid ${job.pid}) by request.`,
					"The command is still running. This is not a completed result.",
					"If you need the outcome before continuing or concluding, wait for it.",
					buildBackgroundJobHelpText(job.id),
				].join(" ");

	return {
		content: [
			{
				type: "text",
				text,
			},
		],
		details: {
			backgroundJob: job,
		},
	};
}

function buildBackgroundJobStatusResult(job: BackgroundJobSnapshot): {
	content: Array<{ type: "text"; text: string }>;
	details: { backgroundJob: BackgroundJobSnapshot };
} {
	let text: string;
	if (job.status === "running") {
		text = `Background job ${job.id} is still running.`;
	} else if (job.status === "exited") {
		text = `Background job ${job.id} completed successfully.`;
	} else if (job.status === "failed") {
		text = `Background job ${job.id} failed${job.exitCode !== undefined ? ` with exit code ${job.exitCode}` : ""}.`;
	} else {
		text = `Background job ${job.id} was killed.`;
	}

	const recentOutput = job.recentOutput.trim();
	if (recentOutput) {
		text += `\nRecent output:\n${recentOutput}`;
	}

	return {
		content: [{ type: "text", text }],
		details: { backgroundJob: job },
	};
}

async function waitForBackgroundJob(id: string, timeoutSeconds: number): Promise<BackgroundJobSnapshot | undefined> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		const job = getBackgroundJob(id);
		if (!job || job.status !== "running") {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return getBackgroundJob(id);
}

/**
 * UTF-8 decoder that handles partial characters across chunks
 */
class Utf8Decoder {
	private buffer = Buffer.alloc(0);

	/**
	 * Feed raw bytes and get complete UTF-8 strings
	 * Returns the complete portion that can be decoded without partial characters
	 */
	feed(data: Buffer): string {
		// Combine with existing buffer
		this.buffer = Buffer.concat([this.buffer, data]);

		// Find valid complete characters by scanning forward
		let validEnd = 0;
		let i = 0;

		while (i < this.buffer.length) {
			const byte = this.buffer[i];

			if ((byte & 0x80) === 0) {
				// ASCII (0xxxxxxx)
				i += 1;
			} else if ((byte & 0xe0) === 0xc0) {
				// 2-byte sequence (110xxxxx 10xxxxxx)
				if (i + 2 > this.buffer.length) break; // Need more bytes
				if ((this.buffer[i + 1] & 0xc0) !== 0x80) {
					i++;
					continue;
				}
				i += 2;
			} else if ((byte & 0xf0) === 0xe0) {
				// 3-byte sequence (1110xxxx 10xxxxxx 10xxxxxx)
				if (i + 3 > this.buffer.length) break; // Need more bytes
				if ((this.buffer[i + 1] & 0xc0) !== 0x80 || (this.buffer[i + 2] & 0xc0) !== 0x80) {
					i++;
					continue;
				}
				i += 3;
			} else if ((byte & 0xf8) === 0xf0) {
				// 4-byte sequence (11110xxx 10xxxxxx 10xxxxxx 10xxxxxx)
				if (i + 4 > this.buffer.length) break; // Need more bytes
				if (
					(this.buffer[i + 1] & 0xc0) !== 0x80 ||
					(this.buffer[i + 2] & 0xc0) !== 0x80 ||
					(this.buffer[i + 3] & 0xc0) !== 0x80
				) {
					i++;
					continue;
				}
				i += 4;
			} else {
				// Invalid byte - skip it
				i++;
			}

			validEnd = i;
		}

		// Only extract complete characters
		const complete = this.buffer.slice(0, validEnd);
		this.buffer = this.buffer.slice(validEnd);

		// Convert to string - complete is guaranteed to be valid UTF-8
		return complete.toString("utf-8");
	}

	/**
	 * Decode all remaining data (may include incomplete sequences)
	 * Used when process finishes to get any leftover data
	 */
	flush(): string {
		return this.buffer.toString("utf-8");
	}
}

/**
 * Get shell configuration based on platform
 */
function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-lc"] };
			}
		}

		throw new Error(
			`Git Bash not found. Please install Git for Windows from https://git-scm.com/download/win\n` +
				`Searched in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}
	// On Unix, avoid `-l` (login shell) to prevent slow/side-effecty shell startup.
	// The Node process already inherits the user's environment (PATH, etc.).
	return { shell: "bash", args: ["-c"] };
}

function buildBashEnv(): NodeJS.ProcessEnv {
	// Some environments set LC_ALL=C.UTF-8 even when that locale isn't installed (common on macOS),
	// which causes bash to emit a warning on every invocation and pollute stdout/stderr.
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (env.LC_ALL === "C.UTF-8") {
		delete env.LC_ALL;
	}
	return env;
}

/**
 * Kill a process and all its children
 */
function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch (e) {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch (e) {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch (e2) {
				// Process already dead
			}
		}
	}
}

const DEFAULT_TIMEOUT = 15; // 15 seconds

const bashSchema = Type.Object({
	command: Type.Optional(Type.String({ description: "Bash command to execute" })),
	job: Type.Optional(Type.String({ description: "Background job id to inspect, wait on, or kill." })),
	action: Type.Optional(
		StringEnum(["status", "wait", "kill"], { description: "Action for a background job id: status, wait, or kill." }),
	),
	background: Type.Optional(
		Type.Boolean({ description: "Whether to start the command in the background and return immediately." }),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (default: 15 seconds).",
		}),
	),
});

// Throttle delay for progress events (ms)
const PROGRESS_FLUSH_DELAY = 100;
// Flush immediately if pending chunk exceeds this size
const PROGRESS_MAX_PENDING_SIZE = 4096;

export const bashTool: AgentTool<typeof bashSchema> = {
	name: "bash",
	label: "bash",
	description: getToolDescription("bash"),
	parameters: bashSchema,
	execute: async (
		_toolCallId: string,
		{
			command,
			job,
			action,
			timeout,
			background,
		}: { command?: string; job?: string; action?: string; timeout?: number; background?: boolean },
		signal?: AbortSignal,
		onProgress?: (chunk: string) => void,
	) => {
		if (job) {
			if (command) {
				throw new Error("bash accepts either a command or a job id, not both");
			}

			const existingJob = getBackgroundJob(job);
			if (!existingJob) {
				throw new Error(`Unknown background job: ${job}`);
			}

			const requestedAction: BackgroundJobAction =
				action === "wait" || action === "kill" || action === "status" ? action : "status";
			if (requestedAction === "status") {
				return buildBackgroundJobStatusResult(existingJob);
			}

			if (requestedAction === "wait") {
				const waitedJob = await waitForBackgroundJob(job, timeout ?? DEFAULT_TIMEOUT);
				if (!waitedJob) {
					throw new Error(`Unknown background job: ${job}`);
				}
				return buildBackgroundJobStatusResult(waitedJob);
			}

			killBackgroundJob(job);
			const killedJob = getBackgroundJob(job);
			if (!killedJob) {
				throw new Error(`Unknown background job: ${job}`);
			}
			return {
				content: [{ type: "text", text: `Killed background job ${job}.` }],
				details: { backgroundJob: killedJob },
			};
		}

		if (!command) {
			throw new Error("bash requires either a command or a job id");
		}

		if (background) {
			const job = startBackgroundJob(command);
			return buildBackgroundJobResult(job);
		}

		return new Promise((resolve, _reject) => {
			const { shell, args } = getShellConfig();
			const child = spawn(shell, [...args, command], {
				detached: true,
				env: buildBashEnv(),
				stdio: ["ignore", "pipe", "pipe"],
			});

			// Setup temporary file for full output logging (eager streaming)
			// This preserves interleaved stdout/stderr ordering for debugging
			let logStream: WriteStream | null = null;
			let logPath: string | null = null;
			let logFileBytes = 0;
			let logFileExceeded = false;

			const finalizeLogStream = (done: () => void) => {
				const stream = logStream;
				logStream = null;
				if (!stream) {
					done();
					return;
				}

				// Ensure buffered data is flushed before we resolve/reject. Otherwise callers/tests
				// may read a partially-written overflow file.
				if (stream.writableEnded) {
					done();
					return;
				}

				stream.end(() => {
					done();
				});
			};

			try {
				const tempDir = tmpdir();
				const randomId = Math.random().toString(36).slice(2, 10);
				const timestamp = Date.now();
				logPath = join(tempDir, `mu-bash-${timestamp}-${randomId}.log`);
				logStream = createWriteStream(logPath);

				// Handle log stream errors gracefully - don't fail the command
				logStream.on("error", () => {
					logStream = null;
				});
			} catch {
				// If we can't create the log file, proceed without it
				logStream = null;
				logPath = null;
			}

			// Use raw buffers and decode UTF-8 manually to handle partial characters
			const stdoutDecoder = new Utf8Decoder();
			const stderrDecoder = new Utf8Decoder();

			// Single combined output buffer - preserves interleaved stdout/stderr order
			let output = "";
			let totalOutputBytes = 0;
			let active = true;
			let didTruncate = false;
			let truncationProgressShown = false;
			let settled = false;
			const startedAt = Date.now();

			// Throttling state for progress events
			let pendingChunk = "";
			let flushTimer: NodeJS.Timeout | null = null;

			const flushProgress = () => {
				if (onProgress && pendingChunk) {
					onProgress(pendingChunk);
					pendingChunk = "";
				}
				flushTimer = null;
			};

			const scheduleFlush = () => {
				if (!flushTimer) {
					flushTimer = setTimeout(flushProgress, PROGRESS_FLUSH_DELAY);
				}
			};

			const handleData = (text: string) => {
				pendingChunk += text;

				// Immediate flush if pending gets too large
				if (pendingChunk.length > PROGRESS_MAX_PENDING_SIZE) {
					if (flushTimer) {
						clearTimeout(flushTimer);
						flushTimer = null;
					}
					flushProgress();
				} else {
					scheduleFlush();
				}
			};

			/**
			 * Truncate a string to fit within a byte limit, ensuring valid UTF-8
			 * Uses binary search on byte positions, not character positions
			 * Ensures we never cut in the middle of a UTF-8 codepoint or end with incomplete sequence
			 */
			const truncateToBytes = (str: string, maxBytes: number): string => {
				if (maxBytes <= 0) return "";
				const buf = Buffer.from(str, "utf-8");

				// If string fits within limit, return as-is
				// The buffer is guaranteed to be valid UTF-8 (from Utf8Decoder.feed)
				if (buf.length <= maxBytes) {
					return str;
				}

				// Binary search for the right byte position
				let left = 0;
				let right = buf.length;

				while (left < right) {
					const mid = Math.floor((left + right + 1) / 2);
					if (mid <= maxBytes) {
						left = mid;
					} else {
						right = mid - 1;
					}
				}

				// Walk back to find a safe UTF-8 boundary
				// We need to ensure the slice [0, left) contains only complete UTF-8 sequences
				while (left > 0) {
					// Try to decode the current slice - if valid UTF-8, we're done
					try {
						new TextDecoder("utf-8", { fatal: true }).decode(buf.slice(0, left));
						return buf.slice(0, left).toString("utf-8");
					} catch {
						// Invalid UTF-8 (truncated in middle of codepoint), move back 1 byte and retry
						left--;
					}
				}

				// If left reached 0 and all above failed, return empty string
				return "";
			};

			/**
			 * Process output chunk, checking limit and stopping capture when reached
			 * Note: We do NOT kill the process - it continues to completion naturally
			 */
			const processOutput = (data: Buffer, source: "stdout" | "stderr") => {
				// Always write raw bytes to log file (preserves interleaved ordering)
				if (logStream?.writable && !logFileExceeded) {
					logStream.write(data);
					logFileBytes += data.length;

					// Enforce 100MB limit to prevent disk exhaustion
					if (logFileBytes >= MAX_LOG_FILE_BYTES) {
						logFileExceeded = true;
						logStream.write(Buffer.from("\n\n... (log file truncated at 100MB limit) ...\n"));
						logStream.end();
						logStream = null;
					}
				}

				if (!active) return;

				// Decode complete UTF-8 sequences, buffering partial characters
				const text = source === "stdout" ? stdoutDecoder.feed(data) : stderrDecoder.feed(data);
				const chunkBytes = Buffer.byteLength(text, "utf-8");

				if (chunkBytes === 0) return; // Nothing complete to process

				const remainingBytes = MAX_OUTPUT_BYTES - totalOutputBytes;

				if (chunkBytes > remainingBytes) {
					// Truncate to fit within remaining bytes
					const truncated = truncateToBytes(text, remainingBytes);
					const truncatedBytes = Buffer.byteLength(truncated, "utf-8");

					// Track if we actually dropped bytes
					if (truncatedBytes < chunkBytes) {
						didTruncate = true;
					}

					// Append truncated content to combined buffer (preserves arrival order)
					output += truncated;
					handleData(truncated);

					// Stop capturing, but let process continue running
					active = false;
					totalOutputBytes = MAX_OUTPUT_BYTES;

					// Emit progress message so user knows command is still running
					if (onProgress && !truncationProgressShown) {
						truncationProgressShown = true;
						handleData("\n[... command still running; output truncated ...]");
					}
				} else {
					// Fits within limit, append to combined buffer (preserves arrival order)
					totalOutputBytes += chunkBytes;
					output += text;
					handleData(text);
				}
			};

			child.on("error", (err) => {
				if (flushTimer) {
					clearTimeout(flushTimer);
					flushTimer = null;
				}

				// Cleanup log file on error
				finalizeLogStream(() => {
					if (logPath) {
						unlink(logPath, () => {});
					}
				});

				_reject(err instanceof Error ? err : new Error(String(err)));
			});

			const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT;
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (effectiveTimeout > 0) {
				timeoutHandle = setTimeout(() => {
					if (settled) {
						return;
					}
					settled = true;
					active = false;
					if (flushTimer) {
						clearTimeout(flushTimer);
						flushTimer = null;
					}
					pendingChunk = "";
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}
					const job = registerBackgroundJob(command, child, {
						startedAt,
						initialOutput: output,
						reason: "timeout_promoted",
					});
					resolve(buildBackgroundJobResult(job));
				}, effectiveTimeout * 1000);
			}

			if (child.stdout) {
				child.stdout.on("data", (data: Buffer) => {
					processOutput(data, "stdout");
				});
			}

			if (child.stderr) {
				child.stderr.on("data", (data: Buffer) => {
					processOutput(data, "stderr");
				});
			}

			child.on("close", (code) => {
				// Clear any pending timer and flush final chunk
				if (flushTimer) {
					clearTimeout(flushTimer);
					flushTimer = null;
				}
				flushProgress();

				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}

				if (settled) {
					finalizeLogStream(() => {
						if (logPath && !didTruncate) {
							unlink(logPath, () => {});
						}
					});
					return;
				}

				if (signal?.aborted) {
					settled = true;
					let result = output;
					if (result) result += "\n\n";
					result += "Command aborted";

					finalizeLogStream(() => {
						// Keep log file if truncated, otherwise delete
						if (didTruncate && logPath) {
							result += `\n\nFull output saved to: ${logPath}`;
						} else if (logPath) {
							unlink(logPath, () => {});
						}

						_reject(new Error(result));
					});
					return;
				}

				// Flush any remaining partial data from decoders
				// Only flush if we didn't hit the output limit
				// Note: flush() may use replacement characters (�) for incomplete UTF-8 at EOF,
				// but this is acceptable as it only affects the very last bytes
				if (!didTruncate) {
					output += stdoutDecoder.flush();
					output += stderrDecoder.flush();
				}

				let result = output;

				finalizeLogStream(() => {
					settled = true;
					// Show truncation notice only if we actually dropped bytes
					if (didTruncate) {
						result += `\n\n... (output truncated to ${MAX_OUTPUT_BYTES} bytes)`;
						if (logPath) {
							result += `\nFull output saved to: ${logPath}`;
						}
					} else if (logPath) {
						// Not truncated - delete the log file (not needed)
						unlink(logPath, () => {});
					}

					if (code !== 0 && code !== null) {
						if (result) result += "\n\n";
						_reject(new Error(result + `Command exited with code ${code}`));
						return;
					}

					resolve({
						content: [{ type: "text", text: result || "(no output)" }],
						details: undefined,
					});
				});
			});

			// Handle abort signal - kill entire process tree
			const onAbort = () => {
				// Clear flush timer on abort
				if (flushTimer) {
					clearTimeout(flushTimer);
					flushTimer = null;
				}
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}
		});
	},
};
