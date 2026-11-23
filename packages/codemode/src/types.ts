import type { CodemodeWasmModule } from "./wasm.ts";

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
	 * The script calls tools as `tools.<id>(args)`, where `<id>` is the name with characters that
	 * are not valid in identifiers replaced by `_` (see `toCodemodeIdentifier`), and also as
	 * `tools["<name>"](args)`. Globals are called as `<name>(args)` and must be identifiers, or
	 * `<namespace>.<member>`, which groups them into a frozen namespace object.
	 */
	name: string;
	/** Shown as a doc comment in {@link renderDeclarations}, and listed in `ALL_TOOLS` for tools. */
	description?: string;
	/** Schema of the single argument. Rendered as the parameter type; `unknown` when omitted. */
	inputSchema?: CodemodeJsonSchema;
	/** Schema of the resolved value. Rendered as the promise type; `unknown` when omitted. */
	outputSchema?: CodemodeJsonSchema;
	/** Globals only: `execute` receives all call arguments as an array instead of the first one. */
	spread?: boolean;
	/**
	 * Globals only: TypeScript parameter list and return type for {@link renderDeclarations}, for
	 * example `(type: string, id?: string): Promise<Model[]>`. Replaces the rendering from the schemas.
	 */
	signature?: string;
	/**
	 * `args` is whatever the script passed, after a JSON round trip. The return
	 * value must be JSON-serializable; a thrown error surfaces in the script as
	 * an `Error` with the same message.
	 */
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

/**
 * One item of the script's output, in the order the script produced it: `text()` and `console.*`
 * produce text items, with `console: true` for `console.*`, and `image()` image items. `data` is base64.
 */
export type CodemodeOutputItem =
	| { type: "text"; text: string; console?: true }
	| { type: "image"; data: string; mimeType: string };

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}

export type CodemodeErrorKind =
	/** The script threw or failed to parse. `name` and `stack` come from the script's error. */
	| "script"
	/**
	 * The overall deadline expired, or the script used up its fuel budget. The execution ended; a remote VM may
	 * still be computing.
	 */
	| "timeout"
	/** The caller's signal fired or the sandbox was closed. The execution ended and the VM was asked to stop. */
	| "aborted"
	/**
	 * The VM or its transport failed outside the script's control (for example a wasm trap, a module
	 * that does not load, or a remote sandbox that failed).
	 */
	| "sandbox";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
}

/** Keys the script changed with `store()`. Only successful executions report writes. */
export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	/** Keys stored as `undefined`. */
	delete: string[];
}

/** `output` is kept for failed executions too, up to the failure. `exit()` completes with `value: undefined`. */
export type CodemodeResult =
	| {
			ok: true;
			value: unknown;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			storeWrites: CodemodeStoreWrites;
	  }
	| {
			ok: false;
			error: CodemodeError;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
	  };

/** Options every sandbox accepts, wherever its VM runs. */
export interface CodemodeSandboxBaseOptions {
	tools?: CodemodeTool[];
	/**
	 * Functions exposed as top-level identifiers instead of on `tools`, for host helpers such as
	 * attaching an image to the result. They behave like tools (JSON round trip, promise result)
	 * but are not recorded in `result.calls`. Names must be identifiers and may not shadow the
	 * built-in globals (`tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `store`, `load`).
	 */
	globals?: CodemodeTool[];
	/**
	 * Overall deadline per execution, including time spent in tools. `Infinity` disables the
	 * deadline; the execution then only ends when the script settles or is aborted.
	 * Default: 300000.
	 */
	timeoutMs?: number;
	/**
	 * Maximum memory the VM may allocate. Past it the script fails with `InternalError: out of memory`.
	 * Default: no limit beyond wasm32's 4 GiB address space.
	 */
	memoryLimitBytes?: number;
}

/** Options of `CodemodeSandbox`, which runs each VM on the calling thread of a Node or Bun host. */
export interface CodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * The compiled djs module, usually from `loadDjsWasm()`. Default: `loadDjsWasm()`, the file in the installed
	 * `@earendil-works/djs` package. Pass it when that file is not on disk, for example in a Bun compiled executable.
	 */
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Fuel one execution may use before it fails with `kind: "timeout"`, across its waits on tools: the only limit on a
	 * script that computes where the clock stands still while code runs (Cloudflare). About 1e9 is 2 seconds of a tight
	 * loop on an Apple M-series laptop. Default: none; `timeoutMs` bounds the script.
	 */
	fuel?: number;
}

/**
 * A call's answer. A rejection becomes an `Error` with `message` in the script, carrying the own properties of
 * `properties` (JSON values; `name`, `message`, and `stack` are ignored), for example `{ structuredOutput }`.
 */
export type CodemodeOutcome =
	| { ok: true; value: unknown }
	| { ok: false; message: string; properties?: Record<string, unknown> };

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** Overrides the sandbox default for this execution. */
	timeoutMs?: number;
	/**
	 * Values the script reads with `load(key)`. Must be JSON-serializable. The script's own
	 * `store()` calls come back as `result.storeWrites`; persisting them is up to the caller.
	 */
	store?: Readonly<Record<string, unknown>>;
}
