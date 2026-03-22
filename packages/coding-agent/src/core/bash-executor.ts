/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import { createTempOutputCapture } from "./temp-output-capture.js";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command with optional streaming and cancellation support.
 *
 * Uses the same local BashOperations backend as createBashTool() so interactive
 * user bash and tool-invoked bash share the same process spawning behavior.
 * Sanitization, newline normalization, temp-file capture, and truncation still
 * happen in executeBashWithOperations(), so reusing the local backend does not
 * change output processing behavior.
 *
 * @param command - The bash command to execute
 * @param options - Optional streaming callback and abort signal
 * @returns Promise resolving to execution result
 */
export function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	return executeBashWithOperations(command, process.cwd(), createLocalBashOperations(), options);
}

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempOutputCapture: ReturnType<typeof createTempOutputCapture> | undefined;
	let totalBytes = 0;

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES && !tempOutputCapture) {
			tempOutputCapture = createTempOutputCapture("pi-bash-", ".log");
			tempFilePath = tempOutputCapture?.path;
			for (const chunk of outputChunks) {
				tempOutputCapture?.write(chunk);
			}
		}

		tempOutputCapture?.write(text);

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		tempOutputCapture?.close();

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		tempOutputCapture?.close();

		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		throw err;
	}
}
