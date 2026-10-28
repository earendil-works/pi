/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcess } from "../utils/child-process.ts";

const DEFAULT_EXEC_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
const FORCE_KILL_DELAY_MS = 5000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Combined stdout/stderr byte limit; exceeding it terminates the command with `truncated: true`.
	 * Nonnegative integer up to the runtime string limit. Default: 256 MiB, capped by that limit.
	 */
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	/** The command was terminated by pi: timeout, abort, or output over `maxBuffer`. */
	killed: boolean;
	/** Output exceeded `maxBuffer`; stdout and stderr are incomplete and `code` is nonzero. */
	truncated: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout, abort signal, and an output cap (`maxBuffer`).
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const maxBuffer = options?.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}

	const proc = spawn(command, args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	// Decode across chunks: a multi-byte UTF-8 character can be split between two chunks,
	// and decoding each chunk separately would corrupt it (earendil-works/pi#11312).
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let outputBytes = 0;
	let truncated = false;
	let killed = false;
	let timeoutId: NodeJS.Timeout | undefined;
	let forceKillId: NodeJS.Timeout | undefined;

	const killProcess = () => {
		if (killed) return;
		killed = true;
		proc.kill("SIGTERM");
		forceKillId = setTimeout(() => {
			// `proc.killed` only says a signal was sent, so check whether the child actually exited.
			if (proc.exitCode === null && proc.signalCode === null) {
				proc.kill("SIGKILL");
			}
		}, FORCE_KILL_DELAY_MS);
	};

	if (options?.signal) {
		if (options.signal.aborted) {
			killProcess();
		} else {
			options.signal.addEventListener("abort", killProcess, { once: true });
		}
	}

	if (options?.timeout && options.timeout > 0) {
		timeoutId = setTimeout(killProcess, options.timeout);
	}

	// Keep only bytes within the combined cap (#11360). Close both pipes on overflow so writing
	// descendants cannot keep waitForChildProcess busy after the child exits. Pausing is not
	// enough: Node resumes the child's stdio on exit.
	const takeWithinCap = (data: Buffer): Buffer | undefined => {
		if (truncated) return undefined;
		const remaining = maxBuffer - outputBytes;
		if (data.length <= remaining) {
			outputBytes += data.length;
			return data;
		}
		truncated = true;
		proc.stdout?.destroy();
		proc.stderr?.destroy();
		killProcess();
		return remaining > 0 ? data.subarray(0, remaining) : undefined;
	};

	proc.stdout?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (chunk) stdout += stdoutDecoder.write(chunk);
	});

	proc.stderr?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (chunk) stderr += stderrDecoder.write(chunk);
	});

	let code: number | null;
	try {
		// Do not hang on inherited stdio handles held open by detached descendants.
		code = await waitForChildProcess(proc);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		// Child-process errors (e.g. ENOENT) are failed executions, not host failures.
		code = 1;
		if (!stderr) stderr = error.message;
	} finally {
		clearTimeout(timeoutId);
		clearTimeout(forceKillId);
		options?.signal?.removeEventListener("abort", killProcess);
	}

	// On truncation, discard any incomplete UTF-8 suffix buffered by either decoder.
	// Flushing it would append a replacement character that was not in the accepted output.
	if (!truncated) {
		stdout += stdoutDecoder.end();
		stderr += stderrDecoder.end();
	}

	const exitCode = code ?? 0;
	return {
		stdout,
		stderr,
		// A truncated result must never read as success.
		code: truncated && exitCode === 0 ? 1 : exitCode,
		killed,
		truncated,
	};
}
