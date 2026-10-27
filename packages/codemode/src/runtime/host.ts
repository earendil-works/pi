import { Worker } from "node:worker_threads";
import type { CodemodeSandboxOptions } from "../types.ts";
import { type CodemodeWasmModule, loadQuickJSWasm } from "../wasm.ts";
import { CodemodeSandboxBase, errorMessage, type VmLauncher } from "./execution.ts";
import type { WorkerData } from "./protocol.ts";

function defaultWorkerUrl(): URL {
	// `.ts` when running from source (tests, tsx), `.js` from the published dist.
	return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

/**
 * Each execution gets its own worker thread and QuickJS VM. A fresh worker per run keeps
 * termination simple: a runaway script, including one that only spins the microtask queue, is
 * killed with `terminate()` and cannot poison a later run. Before terminating, the host sets a
 * shared interrupt flag that the VM polls, because Bun's `terminate()` cannot stop a thread that
 * is spinning in wasm. Stopping requests termination without waiting for exit: some built-ins do
 * not poll the flag, so on Bun a worker can outlive the script's result.
 */
function workerLauncher(options: CodemodeSandboxOptions): VmLauncher {
	return async (data, events) => {
		let module: CodemodeWasmModule;
		try {
			module = await (options.wasm ?? loadQuickJSWasm());
		} catch (error) {
			throw new Error(`Failed to load QuickJS: ${errorMessage(error)}`);
		}
		const interrupt = new SharedArrayBuffer(4);
		const workerData: WorkerData = { ...data, wasm: module, interrupt };
		const releaseWorker = options.acquireWorker?.();
		let worker: Worker;
		try {
			worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), { workerData });
		} catch (error) {
			releaseWorker?.();
			throw new Error(`Failed to start worker: ${errorMessage(error)}`);
		}
		if (releaseWorker) worker.once("exit", releaseWorker);
		worker.on("message", (message: unknown) => {
			// Node 24/26 --watch leaks dependency reports onto the worker channel (nodejs/node#65044).
			if (
				typeof message === "object" &&
				message !== null &&
				("watch:import" in message || "watch:require" in message)
			)
				return;
			events.message(message);
		});
		worker.on("error", (error: unknown) => {
			events.failure({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			});
		});
		worker.on("exit", (code) => {
			events.failure({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		});
		const stop = async (): Promise<void> => {
			Atomics.store(new Int32Array(interrupt), 0, 1);
			// A non-interruptible built-in can delay Bun's terminate() until it returns (#10748).
			// Do not hold up the result while that worker exits.
			void worker.terminate().catch(() => undefined);
			// terminate() refs the worker internally; unref it after requesting termination.
			worker.unref();
		};
		try {
			options.onWorkerStarted?.(new Promise<void>((resolve) => worker.once("exit", () => resolve())));
		} catch (error) {
			void stop();
			throw error;
		}
		return { post: (message) => worker.postMessage(message), stop };
	};
}

/**
 * Runs JavaScript in a QuickJS VM (a separate wasm instance) inside a worker thread. The worker
 * keeps script execution off the host thread: QuickJS runs synchronously, so a spinning script on
 * the host thread would block its event loop. Requires `node:worker_threads` (Node or Bun); see
 * `InlineCodemodeSandbox` and `RemoteCodemodeSandbox` in `@earendil-works/pi-codemode/portable`
 * for other runtimes.
 */
export class CodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: CodemodeSandboxOptions = {}) {
		super(options, workerLauncher(options));
	}
}
