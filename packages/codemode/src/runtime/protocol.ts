import type { CodemodeDuring, CodemodeOutputItem } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";

/**
 * Messages between the host (main thread) and the worker. Tool arguments,
 * results, and values cross as JSON strings: the worker passes them into and
 * out of the QuickJS VM as strings and never builds structured values itself.
 */

/**
 * Everything a VM needs to run one script, independent of where it runs. Plain data, so it can
 * cross a `postMessage` or a Workers RPC call unchanged.
 */
export interface VmStartData {
	code: string;
	/** `jsName` is the identifier the script uses; `description` is listed in `ALL_TOOLS`. */
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	memoryLimitBytes: number | undefined;
	/** Snapshot for `load()`: key to JSON text. */
	store: Record<string, string>;
	/**
	 * Run deterministically (`CodemodeSandboxBase.start()`): UTC, a virtual clock starting at `startedAt` (ms since
	 * the epoch) that moves only with delivered results, randomness from `seed`, no `WeakRef`, results applied in
	 * `seq` order, and `started`/`idle` messages.
	 */
	deterministic?: { startedAt: number; seed: number };
}

export interface WorkerData extends VmStartData {
	/** Compiled `quickjs-wasi` module. Structured clone shares the compiled code with the worker. */
	wasm: CodemodeWasmModule;
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
	| { type: "output"; item: CodemodeOutputItem }
	/**
	 * `writes` is a JSON array of `[key, json]` for `store()` and `[key]` for deletions. Deterministic mode: `during`
	 * is the result the VM was processing when the script finished (0: its first run) and the calls issued by then.
	 */
	| { type: "done"; ok: true; value: string | undefined; writes: string; during?: CodemodeDuring }
	| { type: "done"; ok: false; error: ScriptErrorJson; during?: CodemodeDuring }
	/** The VM failed outside the script's control, for example a wasm trap. */
	| { type: "crash"; message: string }
	/** Deterministic mode, before the script runs: what the VM is, so a replay can refuse a different one. */
	| { type: "started"; fingerprint: string }
	/**
	 * Deterministic mode, after the script waits again: having processed result `seq` (0: the script's first run), it
	 * has issued `issued` calls in total.
	 */
	| { type: "idle"; seq: number; issued: number };

export type HostToWorkerMessage =
	/**
	 * `payload` is the JSON result when `ok`, otherwise the error message. Deterministic mode: `seq` numbers the
	 * results from 1 in the order the VM applies them, and the VM's clock reads `now` while it processes this one.
	 */
	{
		type: "result";
		id: number;
		ok: boolean;
		payload: string | undefined;
		seq?: number;
		now?: number;
		/** Deterministic mode, `ok: false`: a JSON object whose properties the script's `Error` gets. */
		properties?: string;
	};

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return (
		type === "call" ||
		type === "output" ||
		type === "done" ||
		type === "crash" ||
		type === "started" ||
		type === "idle"
	);
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result";
}
