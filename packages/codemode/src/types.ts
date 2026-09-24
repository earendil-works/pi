export interface CodemodeToolContext {
	/**
	 * Aborted when the script finishes (including unawaited calls), the
	 * execution times out, the caller aborts, or the sandbox is closed.
	 */
	signal: AbortSignal;
}

/** A JSON Schema document. Only used to render declarations; values are not validated against it. */
export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

export interface CodemodeTool {
	/**
	 * The script calls this as `tools.<name>(args)` (or `tools["<name>"](args)` for names that are
	 * not identifiers). Globals are called as `<name>(args)` and must be identifiers.
	 */
	name: string;
	/** Shown as a doc comment in {@link renderDeclarations}. */
	description?: string;
	/** Schema of the single argument. Rendered as the parameter type; `unknown` when omitted. */
	inputSchema?: CodemodeJsonSchema;
	/** Schema of the resolved value. Rendered as the promise type; `unknown` when omitted. */
	outputSchema?: CodemodeJsonSchema;
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
	/**
	 * Functions exposed as top-level identifiers instead of on `tools`, for host helpers such as
	 * attaching an image to the result. They behave like tools (JSON round trip, promise result)
	 * but are not recorded in `result.calls`. Names must be identifiers and may not shadow
	 * `tools` or `console`.
	 */
	globals?: CodemodeTool[];
	/**
	 * Overall deadline per execution, including time spent in tools. `Infinity` disables the
	 * deadline; the execution then only ends when the script settles or is aborted.
	 * Default: 300000.
	 */
	timeoutMs?: number;
	/** Worker heap limit. Enforced on Node; Bun ignores it. Default: runtime default. */
	maxOldGenerationSizeMb?: number;
}

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** Overrides the sandbox default for this execution. */
	timeoutMs?: number;
}
