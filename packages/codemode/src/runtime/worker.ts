/**
 * Worker thread entry. One worker runs one script inside a fresh QuickJS VM
 * (a separate wasm instance), relays tool calls and logs to the host, and
 * reports the result. The host terminates the worker when the script settles,
 * times out, or is aborted; the worker exists so that a spinning script never
 * blocks the host thread.
 *
 * Importing this module starts the worker. Hosts that bundle their code (for
 * example a Bun compiled executable) add a file that imports
 * `@earendil-works/pi-codemode/worker` as a separate entrypoint and pass its URL
 * as `workerUrl`.
 */
import { parentPort, workerData } from "node:worker_threads";
import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import { isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";

function post(message: WorkerToHostMessage): void {
	parentPort?.postMessage(message);
}

function crash(error: unknown): void {
	post({ type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
}

/**
 * QuickJS writes engine diagnostics to fd 1 and 2, which the default shim
 * forwards to the host's stdout and stderr. That output belongs to the host
 * application (for example a TUI), so it is discarded. Reporting every byte as
 * written keeps libc from retrying.
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head });
}

async function main(data: WorkerData): Promise<void> {
	const interrupt = new Int32Array(data.interrupt);
	const vm = await QuickJS.create({
		wasm: data.wasm,
		memoryLimit: data.memoryLimitBytes,
		// Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a
		// catchable RangeError.
		maxStackSize: MAX_STACK_SIZE,
		interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
		wasi: discardOutput,
	});

	// Called from the prelude with primitives only.
	const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
		switch (kind.toString()) {
			case "call":
			case "global":
				post({
					type: "call",
					id: a.toNumber(),
					target: kind.toString() === "call" ? "tool" : "global",
					name: b.toString(),
					args: c === undefined || c.isUndefined ? undefined : c.toString(),
				});
				break;
			case "log":
				post({ type: "log", level: a.toString(), message: b.toString() });
				break;
			case "done":
				if (a.toBoolean()) {
					post({ type: "done", ok: true, value: b === undefined || b.isUndefined ? undefined : b.toString() });
				} else {
					post({ type: "done", ok: false, error: b.toString() });
				}
				break;
		}
		return vm.undefined;
	});

	// The VM lives until the host terminates the worker, so these handles are never disposed.
	const api = vm.withScope((scope) =>
		scope.escape(
			vm.callFunction(
				vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
				vm.undefined,
				bridge,
				vm.newString(JSON.stringify(data.toolNames)),
				vm.newString(JSON.stringify(data.globalNames)),
			),
		),
	);
	const settle = api.getProp("settle");
	const run = api.getProp("run");

	parentPort?.on("message", (message: unknown) => {
		if (!isHostToWorkerMessage(message)) return;
		try {
			vm.withScope(() => {
				vm.callFunction(
					settle,
					api,
					vm.newNumber(message.id),
					message.ok ? vm.true : vm.false,
					message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				);
			});
			vm.executePendingJobs();
		} catch (error) {
			crash(error);
		}
	});

	// The prefix shares the first line with the script so reported line numbers
	// match the script as written.
	let fn: JSValueHandle;
	try {
		fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
	} catch (error) {
		if (!(error instanceof JSException)) throw error;
		post({ type: "done", ok: false, error: describeException(error) });
		return;
	}
	vm.callFunction(run, api, fn).dispose();
	fn.dispose();
	vm.executePendingJobs();
}

if (parentPort) {
	main(workerData as WorkerData).catch(crash);
}
