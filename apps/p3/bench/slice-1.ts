// Slice 1's numbers (`docs/slices/01-base-and-sessions.md`, Numbers): the real p3 server on a temporary data directory,
// a client over WebSocket as the owner. Prints the server's start and anonymous RSS (what Node does not share between
// processes), a session worker's start (cold: the first after the server's start, with the worker base's build; warm:
// the next ones, median of 10) and an idle worker's anonymous RSS.
// Run from apps/p3: node --conditions=source --disable-warning=ExperimentalWarning bench/slice-1.ts

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type P3Principal, Session } from "@p3/app/v1";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { startP3 } from "../server.ts";
import { ownerClient } from "../test/client.ts";

/** A process's anonymous resident memory in MiB (`RssAnon` of `/proc/<pid>/status`). */
async function rssAnon(pid: number | "self"): Promise<number> {
	const status = await readFile(`/proc/${pid}/status`, "utf8");
	return Number(/RssAnon:\s+(\d+)/.exec(status)?.[1]) / 1024;
}

/** The median of `values`. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/** Creates a session and returns its id and how long its worker took from the first hold to live, in ms. */
async function workerStart(client: Host<P3Principal>): Promise<{ readonly ms: number; readonly id: string }> {
	const sessions = await client.get(Sessions, {}, context);
	const id = await sessions.create({}, context);
	const at = performance.now();
	await client.get(SessionWorker, { session: id }, context);
	return { ms: performance.now() - at, id };
}

const dir = await mkdtemp(join(tmpdir(), "p3-bench-"));
try {
	const started = performance.now();
	const app = await startP3(context, { dataDir: join(dir, "data"), port: 0 });
	try {
		const listening = performance.now() - started;
		const client = await ownerClient(app, context);
		try {
			const cold = await workerStart(client);
			const warm: number[] = [];
			for (let i = 0; i < 10; i++) warm.push((await workerStart(client)).ms);
			const state = app.workers.get(Session.kind)?.state.value[Session({ id: cold.id }).key];
			// Idle: give the worker a moment after its first answer.
			await new Promise((resolve) => setTimeout(resolve, 500));
			console.log(`server listening        ${listening.toFixed(0)} ms`);
			console.log(
				`server RssAnon          ${(await rssAnon("self")).toFixed(1)} MiB (this process: server and client)`,
			);
			console.log(`worker start, cold      ${cold.ms.toFixed(0)} ms (with the worker base's build)`);
			console.log(`worker start, warm      ${median(warm).toFixed(0)} ms (median of 10)`);
			if (state?.status === "running")
				console.log(`worker RssAnon (idle)   ${(await rssAnon(state.pid)).toFixed(1)} MiB`);
		} finally {
			await client.close(context);
		}
	} finally {
		await app.close(context);
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}
