export interface CodemodeToolContext {
	/**
	 * Aborted when the script finishes (including unawaited calls), the
	 * execution times out, the caller aborts, or the sandbox is closed.
	 */
	signal: AbortSignal;
}

export interface CodemodeTool {
	/** The script calls this as `tools.<name>(args)`. */
	name: string;
	/**
	 * `args` is whatever the script passed, after a JSON round trip. The return
	 * value must be JSON-serializable; a thrown error surfaces in the script as
	 * an `Error` with the same message.
	 */
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

export type CodemodeLogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface CodemodeLog {
	level: CodemodeLogLevel;
	message: string;
}

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}

export type CodemodeErrorKind =
	/** The script threw or failed to parse. `name` and `stack` come from the script's error. */
	| "script"
	/** The overall deadline expired. The worker was terminated. */
	| "timeout"
	/** The caller's signal fired or the sandbox was closed. The worker was terminated. */
	| "aborted"
	/** The worker died on its own (for example out of memory). */
	| "sandbox";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
}

export type CodemodeResult =
	| { ok: true; value: unknown; logs: CodemodeLog[]; calls: CodemodeCall[] }
	| { ok: false; error: CodemodeError; logs: CodemodeLog[]; calls: CodemodeCall[] };

export interface CodemodeSandboxOptions {
	tools?: CodemodeTool[];
	/** Overall deadline per execution, including time spent in tools. Default: 300000. */
	timeoutMs?: number;
	/** Worker heap limit. Enforced on Node; Bun ignores it. Default: runtime default. */
	maxOldGenerationSizeMb?: number;
}

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** Overrides the sandbox default for this execution. */
	timeoutMs?: number;
}
