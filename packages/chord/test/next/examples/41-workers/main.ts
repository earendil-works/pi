// Workers (slice 10): the server routes a session's address to its own worker process. The first reference to a
// session starts its worker; once nobody uses it for `idleMs`, the worker stops. The worker's code is the sessions
// plugin (`plugins/`), built by the server and shipped to the worker.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/41-workers/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { hostKind } from "../../../../src/next/contracts/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";
import { createWorkers } from "../../../../src/next-node/workers/index.ts";
import { Greeting, Session } from "./plugins/sessions/contract.ts";

const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { worker: { platform: "node", hostPackages: ["@earendil-works/chord/next"] } },
		onError: console.error,
	},
	context,
);

// 1. The server, and its workers: one forked process per session, stopped after 300 ms without use.
const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: console.error });
const workers = createWorkers(
	server,
	Session,
	{
		kind: "worker",
		entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
		execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
		authorize: () => true,
		principal: (address) => ({ kind: "worker", session: address.params.id }),
		start: () => ({}),
		lock: (address) => `example-41:${process.pid}:${address.key}`,
		idleMs: () => 300,
		plugins,
		onError: console.error,
	},
	context,
);
await server.load([], context);

// 2. Every change of the workers' state, printed.
const watch = await workers.state.watch(context);
watch.start(async (call) => {
	if (call.kind !== "value") return;
	const entries = Object.entries(call.value).map(([key, state]) => `${key} ${state.status}`);
	console.log(`   workers: ${entries.join(", ") || "none"}`);
});

// 3. The first reference starts the worker; the greeting comes from that process.
console.log("1. getting S1's greeting");
const greeting = await server.get(Greeting, { id: "S1" }, context);
console.log(`2. "${greeting.text.value}" (worker pid ${greeting.pid.value}, server pid ${process.pid})`);

// 4. Releasing it leaves the worker idle: 300 ms later it stops.
greeting.release();
console.log("3. released; waiting for the idle stop");
while (Object.keys(workers.state.value).length > 0) {
	await new Promise((resolve) => setTimeout(resolve, 50));
}
console.log("4. stopped");

await watch.stop();
await workers.close(context);
await server.close(context);
plugins.close();
