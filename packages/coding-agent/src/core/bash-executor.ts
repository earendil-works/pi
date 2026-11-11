/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { OutputArtifacts } from "./output-artifacts.ts";
import type { BashOperations } from "./tools/bash.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session-owned retention and adaptive inline budget when executing through Pi. */
	outputArtifacts?: OutputArtifacts;
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
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const capture = options?.outputArtifacts?.capture();
	const output = capture?.output ?? new OutputAccumulator({ tempFilePrefix: "pi-bash" });
	const signal = options?.signal ? AbortSignal.any([options.signal, output.fileErrorSignal]) : output.fileErrorSignal;
	const decoder = new TextDecoder();
	let pendingAnsi = "";
	let acceptingOutput = true;
	const appendText = (raw: string) => {
		const text = sanitizeBinaryOutput(stripAnsi(raw)).replace(/\r/g, "");
		if (!text) return;
		output.append(Buffer.from(text));
		options?.onChunk?.(text);
	};
	const onData = (data: Buffer) => {
		if (!acceptingOutput) return;
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
		return output.whenDrained();
	};
	let exitCode: number | null = null;
	let failure: { error: unknown } | undefined;
	try {
		({ exitCode } = await operations.exec(command, cwd, { onData, signal }));
	} catch (error) {
		if (!options?.signal?.aborted) failure = { error };
	} finally {
		acceptingOutput = false;
	}
	appendText(pendingAnsi + decoder.decode());
	output.finish();
	await output.closeTempFile();
	const snapshot = output.snapshot();
	let text = snapshot.content;
	if (capture?.artifact)
		text = `[Full captured output: ${capture.artifact.uri}. Use read with offset/limit or byteOffset.]\n\n${text}`;
	if (failure) {
		if (!capture?.artifact) throw failure.error;
		const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
		throw new Error(`${text}\n\n${message}`, { cause: failure.error });
	}
	const cancelled = options?.signal?.aborted ?? false;
	return {
		output: text,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: snapshot.truncation.truncated,
		fullOutputPath: snapshot.fullOutputPath,
	};
}
