// Benchmark of the workers component (slice 10 §7): a worker's cold start with shipped scripts (fork to `started`, fork
// to `ready`, medians over runs) and the server's memory per idle worker (heap after a GC, 20 workers running idle).
// Run by hand from packages/chord (not in CI), pinned:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/bench/workers.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind, str } from "../../src/contracts/index.ts";
import { createHost } from "../../src/host/index.ts";
import * as chord from "../../src/index.ts";
import { createPlugins } from "../../src/node/plugins/index.ts";
import type { FromWorker } from "../../src/node/workers/control.ts";
import { createWorkers } from "../../src/node/workers/index.ts";
import { WorkerProcess } from "../../src/node/workers/process.ts";
import { Control } from "../node/fixtures/workers/control.ts";

const RUNS = 7;
const WORKERS = 20;
const ENTRY = fileURLToPath(new URL("../node/fixtures/workers/worker.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../node/fixtures/workers/plugins/", import.meta.url));
const EXEC_ARGV = ["--conditions=source", "--experimental-strip-types", "--no-warnings"];

const gc = (globalThis as { gc?: () => void }).gc!;
const Session = hostKind("session", { id: str() });
const modules = { "@earendil-works/chord": chord };
const plugins = createPlugins(
	{ roots: [ROOT], kinds: { worker: { platform: "node", hostPackages: Object.keys(modules) } }, onError: () => {} },
	context,
);
const scripts = await plugins.scripts("worker", context);

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

// Cold starts: a fork with the shipped scripts, timed to `started` and to `ready`.
const started: number[] = [];
const ready: number[] = [];
for (let run = 0; run < RUNS; run++) {
	const forked = performance.now();
	const times: { started?: number; ready?: number } = {};
	const done = Promise.withResolvers<void>();
	const child = new WorkerProcess(
		{ entry: ENTRY, execArgv: EXEC_ARGV, onOutput: () => {} },
		{
			control: (message: FromWorker) => {
				if (message.kind === "started") times.started = performance.now() - forked;
				if (message.kind === "ready") {
					times.ready = performance.now() - forked;
					done.resolve();
				}
			},
			linkLost: () => {},
			linkClosed: () => {},
			exited: () => {},
		},
	);
	child.send({
		kind: "start",
		address: Session({ id: `R${run}` }),
		start: {},
		scripts,
		lock: `bench:${process.pid}:${run}`,
	});
	await done.promise;
	started.push(times.started!);
	ready.push(times.ready!);
	child.kill();
	await child.exited;
}
console.log(
	`cold start (${scripts.length} shipped script): fork to started ${median(started).toFixed(0)} ms, to ready ${median(ready).toFixed(0)} ms (median of ${RUNS})`,
);

// Memory per idle worker on the server: its records, process handle, link and remote references.
const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: () => {} });
const workers = await createWorkers(
	server,
	Session,
	{
		kind: "worker",
		entry: ENTRY,
		execArgv: EXEC_ARGV,
		authorize: () => true,
		principal: () => ({ kind: "worker" }),
		start: () => ({}),
		lock: (address) => `bench:${process.pid}:${address.key}`,
		plugins,
		onOutput: () => {},
		onError: () => {},
	},
	context,
);
await server.load([], context);
gc();
const before = process.memoryUsage().heapUsed;
const held = [];
for (let i = 0; i < WORKERS; i++) held.push(await server.get(Control, { id: `W${i}` }, context));
gc();
const after = process.memoryUsage().heapUsed;
console.log(
	`server heap per idle worker: ${((after - before) / WORKERS / 1024).toFixed(1)} KiB (${WORKERS} workers, one reference each)`,
);
for (const ref of held) ref.release();
await workers.close(context);
await server.close(context);
plugins.close();
