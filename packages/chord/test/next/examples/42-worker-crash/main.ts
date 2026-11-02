// A worker crash (slice 10): workers never restart by themselves. A crashed worker's address stays failed, its
// holders see `failed` with the error, and nothing forks until the app retries (a Retry button) or a rollout ships new
// code. Here: a session crashes, stays failed for a while, then Retry brings it back.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/42-worker-crash/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { hostKind } from "../../../../src/next/contracts/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";
import { createWorkers } from "../../../../src/next-node/workers/index.ts";
import { Process, Session } from "./plugins/sessions/contract.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { worker: { platform: "node", hostPackages: ["@earendil-works/chord/next"] } },
		onError: console.error,
	},
	context,
);
const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: () => {} });
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
		lock: (address) => `example-42:${process.pid}:${address.key}`,
		plugins,
		onError: (error) => console.log(`   reported: ${error.kind}`),
	},
	context,
);
await server.load([], context);

// 1. A held session (a tab showing it): its worker runs.
const session = server.hold(Process, { id: "S1" }, context);
const state = () => session.state.value.kind;
while (state() !== "live") await sleep(10);
console.log(`1. S1 runs in process ${session.pid.value}`);

// 2. It crashes. The address is failed, and the holder sees why; it stays on the address's path.
await session.crash(context);
while (state() !== "failed") await sleep(10);
const failed = workers.state.value["session|S1"];
console.log(`2. crashed: ${failed?.status === "failed" ? failed.error.message : failed?.status}`);

// 3. No restart loop: a second later it is still failed, and no other worker was started.
await sleep(1_000);
console.log(`3. a second later: ${workers.state.value["session|S1"]?.status}, the holder: ${state()}`);

// 4. Retry (the app's button): the worker starts again and the same holder binds to it.
await workers.retry(Session({ id: "S1" }), context);
while (state() !== "live") await sleep(10);
console.log(`4. after Retry: S1 runs in process ${session.pid.value}`);

session.release();
await workers.close(context);
await server.close(context);
plugins.close();
