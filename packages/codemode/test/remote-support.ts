// An in-process remote for RemoteCodemodeSandbox: it serves executions here and structured-clones every message, as
// Workers RPC would, and records what crosses the boundary.
import {
	type CodemodeRemote,
	type CodemodeServeOptions,
	loadCodemodeWasm,
	serveCodemodeRemote,
} from "../src/portable.ts";

/** The remote, the number of messages of each exchange, and each execution's serve promise. */
export function inProcessRemote(options: Partial<CodemodeServeOptions> = {}) {
	const exchanges: number[] = [];
	const served: Promise<void>[] = [];
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
	};
	return { remote, exchanges, served };
}
