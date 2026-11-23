// An in-process remote for RemoteCodemodeSandbox: it serves executions here and structured-clones every message, as
// Workers RPC would, and records what crosses the boundary.
import {
	type CodemodeRemote,
	type CodemodeServeOptions,
	loadCodemodeWasm,
	serveCodemodeRemote,
	serveCodemodeStep,
} from "../src/portable.ts";

/** The remote, the number of messages of each exchange, each execution's serve promise, and the steps it served. */
export function inProcessRemote(options: Partial<CodemodeServeOptions> = {}) {
	const exchanges: number[] = [];
	const served: Promise<void>[] = [];
	const steps = { count: 0 };
	const remote: CodemodeRemote = {
		execute(request, exchange) {
			const done = serveCodemodeRemote(
				structuredClone(request),
				async (messages) => {
					exchanges.push(messages.length);
					return structuredClone(await exchange(structuredClone(messages)));
				},
				{ wasm: loadCodemodeWasm(), ...options },
			);
			served.push(done);
			return done;
		},
		async step(request) {
			steps.count++;
			return structuredClone(
				await serveCodemodeStep(structuredClone(request), { wasm: loadCodemodeWasm(), ...options }),
			);
		},
	};
	return { remote, exchanges, served, steps };
}
