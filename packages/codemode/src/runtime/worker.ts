/**
 * Worker thread entry. One worker runs one script inside a fresh QuickJS VM
 * (a separate wasm instance), relays tool calls and output to the host, and
 * reports the result. The host terminates the worker when the script settles,
 * times out, or is aborted; the worker exists so that a spinning script never
 * blocks the host thread.
 *
 * Importing this module starts the worker. Hosts that bundle their code (for
 * example a Bun compiled executable) add a file that imports
 * `@earendil-works/pi-codemode/worker` as a separate entrypoint and pass its URL
 * or embedded-module string specifier as `workerUrl`.
 */
import { parentPort, workerData } from "node:worker_threads";
import { isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";
import { startVm } from "./vm.ts";

function post(message: WorkerToHostMessage): void {
	parentPort?.postMessage(message);
}

async function main(data: WorkerData): Promise<void> {
	const interrupt = new Int32Array(data.interrupt);
	// The VM lives until the host terminates the worker, so the session is never disposed.
	const session = await startVm({
		data,
		wasm: data.wasm,
		post,
		shouldInterrupt: () => Atomics.load(interrupt, 0) !== 0,
	});
	parentPort?.on("message", (message: unknown) => {
		if (isHostToWorkerMessage(message)) session.deliver(message);
	});
}

if (parentPort) {
	main(workerData as WorkerData).catch((error: unknown) => {
		post({ type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
	});
}
