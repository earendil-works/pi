// The skeleton's numbers (ERNDL-954), with p3 launched as its owner starts it, each phase timed at the boundary its
// label names:
// - the server's launch to ready: `p3 server` spawned until it printed its port and owner link (after it listens, kept
//   its port and asked its own socket for the link); the first launch cold (the release: an empty Node compile cache),
//   then warm;
// - an apply with nothing changed: the owner's `apply` over the data directory's socket until its answer (the
//   command's round trip and the rollout's steps; no worker runs, so the worker plugins are not built), the owner
//   signed in before the timer; an answer that is not a rollout to every host ends the bench;
// - a session worker's start: a hold of its `SessionWorker` until the object is there (the route's admission, the
//   fork, the worker's load, its handshake); the first, which also builds the worker plugins (their first need), then
//   warm;
// - memory as `performance.md` reads it: USS (what only that process holds) of the server and of idle workers (the
//   server's children that run the worker entry: esbuild's service is a child too), each read settled (until it moves
//   less than 0.25 MiB over 4 s, at most 40 s).
// Times are medians of 20 runs with min and max, the first (cold) run apart.
// Run from apps/p3, with Node 26: node --conditions=source --disable-warning=ExperimentalWarning bench/skeleton.ts
// [--release <dir>]: with it, the release `npm run release:p3:local -- --out <dir>` installed in `<dir>/install` runs.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { COMMAND } from "../src/install.ts";
import { askServer, type Reply, type ServerAnswer } from "../src/local-socket.ts";
import { childrenOf, launch, ownerClient } from "../test/support.ts";

/** Node's arguments that run the `p3` command: the release installed in `--release`, else this checkout's source. */
const { release } = parseArgs({ options: { release: { type: "string" } } }).values;
const P3 =
	release === undefined
		? COMMAND
		: [join(release, "install", "node_modules", "@earendil-works", "p3", "dist", "p3.js")];
console.log(`p3 from ${release === undefined ? "source" : `the release in ${release}`}, Node ${process.versions.node}`);

/** How many warm launches and worker starts are measured (the cold first comes on top). */
const RUNS = 20;

const root = await mkdtemp(join(tmpdir(), "p3-bench-"));
// The release enables Node's compile cache: a directory of the bench's own, empty for the cold launch. A source run
// has none (as a checkout's `p3`), whatever this shell set.
const env =
	release === undefined
		? { ...process.env, NODE_COMPILE_CACHE: undefined }
		: { ...process.env, NODE_COMPILE_CACHE: join(root, "compile-cache") };
try {
	const launches: number[] = [];
	for (let i = 0; i <= RUNS; i++) {
		const started = performance.now();
		const server = await launch(P3, join(root, `launch-${i % 2}`), env);
		launches.push(performance.now() - started);
		await server.stop();
	}
	line("server: launch to ready, cold (first)", `${launches[0]!.toFixed(0)} ms`);
	line("server: launch to ready, warm", stats(launches.slice(1)));

	const server = await launch(P3, join(root, "pi"), env);
	try {
		const client = await ownerClient(server.dataDir, server.port, 30_000);
		const sessions = await client.get(Sessions, {}, context);
		const applying = performance.now();
		const applied = await askServer(server.dataDir, { kind: "command", name: "apply" }, 60_000);
		const apply = performance.now() - applying;
		rolledOut(applied);
		line("an apply, nothing changed", `${apply.toFixed(0)} ms`);
		const starts: number[] = [];
		const held: { release(): void }[] = [];
		for (let i = 0; i <= RUNS; i++) {
			const id = await sessions.create({ title: `s${i}` }, context);
			const started = performance.now();
			held.push(await client.get(SessionWorker, { session: id }, context));
			starts.push(performance.now() - started);
		}
		line("worker: start to its first object, the first (builds)", `${starts[0]!.toFixed(0)} ms`);
		line("worker: start to its first object, warm", stats(starts.slice(1)));
		line("server, settled", `USS ${mib(await settled(server.pid))}`);
		const workers = (await childrenOf(server.pid)).filter(({ args }) =>
			args.some((arg) => /[/\\]worker\.(js|ts)$/.test(arg)),
		);
		if (workers.length !== held.length) throw new Error(`bench: ${workers.length} workers run, not ${held.length}`);
		const idle = await Promise.all(workers.map(({ pid }) => settled(pid)));
		line(`idle worker, settled (median of ${idle.length})`, `USS ${mib(median(idle))}`);
		for (const each of held) each.release();
		await client.close(context);
	} finally {
		await server.stop();
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

/** What the control plugin's `apply` answers of one host (`plugins/control/server.ts`). */
type AppliedHost = {
	readonly host: string;
	readonly failed?: readonly string[];
	readonly stopped?: true;
	readonly error?: string;
};

/** Throws unless `reply` is an apply's answer that rolled out to every host with no plugin failed. */
function rolledOut(reply: Reply<ServerAnswer>): void {
	if (reply.kind === "answered" && reply.answer.kind === "answer") {
		// The control plugin's answer to `apply`.
		const { steps, stopped } = reply.answer.value as {
			readonly steps: readonly { readonly hosts: readonly AppliedHost[] }[];
			readonly stopped: string | null;
		};
		const hosts = steps.flatMap((step) => step.hosts);
		const failed = hosts.some(({ failed, stopped, error }) => (failed?.length ?? 0) > 0 || stopped || error);
		if (stopped === null && !failed) return;
	}
	throw new Error(`bench: the apply failed: ${JSON.stringify(reply)}`);
}

/** The USS of `pid` in KiB once it settled: it moved less than 0.25 MiB over 4 s, or 40 s passed. */
async function settled(pid: number): Promise<number> {
	const deadline = Date.now() + 40_000;
	let last = await uss(pid);
	for (;;) {
		await sleep(4000);
		const now = await uss(pid);
		if (Math.abs(now - last) < 256 || Date.now() > deadline) return now;
		last = now;
	}
}

/** The USS of `pid` in KiB: `Private_Clean + Private_Dirty`. */
async function uss(pid: number): Promise<number> {
	const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
	const kb = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(rollup)?.[1] ?? 0);
	return kb("Private_Clean") + kb("Private_Dirty");
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

function stats(values: readonly number[]): string {
	return `median ${median(values).toFixed(0)} ms (min ${Math.min(...values).toFixed(0)}, max ${Math.max(...values).toFixed(0)}, n ${values.length})`;
}

function mib(kib: number): string {
	return `${(kib / 1024).toFixed(1)} MiB`;
}

function line(name: string, value: string): void {
	console.log(`${name.padEnd(56)}${value}`);
}
