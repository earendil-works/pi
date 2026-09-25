import type { CodemodeWasmModule } from "../wasm.ts";

/**
 * Messages between the host (main thread) and the worker. Tool arguments,
 * results, and values cross as JSON strings: the worker passes them into and
 * out of the QuickJS VM as strings and never builds structured values itself.
 */

export interface WorkerData {
	code: string;
	toolNames: string[];
	globals: { name: string; spread: boolean }[];
	/** Compiled `quickjs-wasi` module. Structured clone shares the compiled code with the worker. */
	wasm: CodemodeWasmModule;
	memoryLimitBytes: number | undefined;
	/** Snapshot for `load()`: key to JSON text. */
	store: Record<string, string>;
	/**
	 * One Int32 the host sets to non-zero before terminating the worker. The VM's interrupt handler
	 * polls it, because Bun's `worker.terminate()` cannot stop a thread that is spinning in wasm.
	 */
	interrupt: SharedArrayBuffer;
}

/** JSON-encoded `{ name?, message, stack? }` of an error thrown by the script. */
export type ScriptErrorJson = string;

export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	| { type: "log"; level: string; message: string }
	/** `writes` is a JSON array of `[key, json]` for `store()` and `[key]` for deletions. */
	| { type: "done"; ok: true; value: string | undefined; writes: string }
	| { type: "done"; ok: false; error: ScriptErrorJson }
	/** The VM failed outside the script's control, for example a wasm trap. */
	| { type: "crash"; message: string };

export type HostToWorkerMessage =
	/** `payload` is the JSON result when `ok`, otherwise the error message. */
	{ type: "result"; id: number; ok: boolean; payload: string | undefined };

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "call" || type === "log" || type === "done" || type === "crash";
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result";
}
