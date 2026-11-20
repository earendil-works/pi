// The skeleton's numbers (ERNDL-954), with p3 launched as a user starts it, from the source checkout: the server's
// launch to listening (cold: the first, an empty compile cache; then warm), the worker plugins' build (the server
// builds them when they are first needed: here an owner's apply asks for them), a session worker's start (the first,
// then warm), and memory as `performance.md` reads it: USS (what only that process holds) of the server and of idle
// workers (the server's children that run the worker entry: esbuild's service is a child too), each read settled
// (until it moves less than 0.25 MiB over 4 s, at most 40 s).
// Run from apps/p3, with Node 26: node --conditions=source --disable-warning=ExperimentalWarning bench/skeleton.ts
// [--release <dir>]: with it, the release `npm run release:p3:local -- --out <dir>` installed in `<dir>/install` runs.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createHost, type Host, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { P3Principal } from "@earendil-works/p3/v1";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { COMMAND } from "../src/install.ts";
import { ownerCookie } from "../test/support.ts";

/** Node's arguments that run the `p3` command: the release installed in `--release`, else this checkout's source. */
const { release } = parseArgs({ options: { release: { type: "string" } } }).values;
const P3 =
	release === undefined
		? COMMAND
		: [join(release, "install", "node_modules", "@earendil-works", "p3", "dist", "p3.js")];
console.log(`p3 from ${release === undefined ? "source" : `the release in ${release}`}, Node ${process.versions.node}`);

/** How many launches and worker starts are measured. */
const RUNS = 10;

/** How many idle workers' memory is read. */
const WORKERS = 10;

const root = await mkdtemp(join(tmpdir(), "p3-bench-"));
try {
	const launches: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const server = await launch(join(root, `launch-${i % 2}`));
		launches.push(server.listening);
		await server.stop();
	}
	line("server: launch to listening, cold (first)", `${launches[0]!.toFixed(0)} ms`);
	line("server: launch to listening, warm", stats(launches.slice(1)));

	const server = await launch(join(root, "pi"));
	try {
		const client = await ownerClient(server.dataDir, server.port);
		const sessions = await client.get(Sessions, {}, context);
		const building = performance.now();
		const applied = await fetch(`http://127.0.0.1:${server.port}/_p3/apply`, {
			method: "POST",
			headers: { cookie: await ownerCookie(server.dataDir, server.port) },
		});
		if (!applied.ok) throw new Error(`bench: the apply failed: ${applied.status}`);
		line("worker plugins: build (asked by an apply)", `${(performance.now() - building).toFixed(0)} ms`);
		const starts: number[] = [];
		const held: { release(): void }[] = [];
		for (let i = 0; i < Math.max(RUNS, WORKERS); i++) {
			const id = await sessions.create({ title: `s${i}` }, context);
			const started = performance.now();
			held.push(await client.get(SessionWorker, { session: id }, context));
			starts.push(performance.now() - started);
		}
		line("worker: start, the first (plugins built)", `${starts[0]!.toFixed(0)} ms`);
		line("worker: start, warm", stats(starts.slice(1)));
		line("server, settled", `USS ${mib(await settled(server.pid))}`);
		const workers = await workersOf(server.pid);
		if (workers.length !== WORKERS) throw new Error(`bench: ${workers.length} workers run, not ${WORKERS}`);
		const idle = await Promise.all(workers.map(settled));
		line(`idle worker, settled (median of ${idle.length})`, `USS ${mib(median(idle))}`);
		for (const each of held) each.release();
		await client.close(context);
	} finally {
		await server.stop();
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

/** A server launched in the foreground on `dataDir`: its pid, port and how long it took to listen. */
async function launch(dataDir: string) {
	const started = performance.now();
	const child = spawn(process.execPath, [...P3, "server", "--dir", dataDir, "--port", "0"], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const found = /port (\d+)\. Open/.exec(out);
			if (found !== null) resolve(Number(found[1]));
		});
		child.once("exit", (code) => reject(new Error(`p3 server exited with ${code}`)));
	});
	return { pid: child.pid!, port, dataDir, listening: performance.now() - started, stop: () => stop(child) };
}

/** Stops `child` with `SIGTERM` and waits for its exit. */
async function stop(child: ChildProcess): Promise<void> {
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await exited;
}

/** A client of the server on `port`, signed in as the owner with a fresh owner link's cookie. */
async function ownerClient(dataDir: string, port: number): Promise<Host<P3Principal>> {
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols.
	const init = { headers: { cookie: await ownerCookie(dataDir, port) } } as unknown as string[];
	const client = createHost<P3Principal>({ readyTimeout: 30_000, onError: (error) => console.error(error) });
	client.connect(
		webSocketLink(new WebSocket(`ws://127.0.0.1:${port}/chord`, init)),
		{ principal: { kind: "server" } },
		context,
	);
	await client.load([], context);
	return client;
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

/**
 * The session workers of the server `pid`: its children whose command line runs the worker entry (`/proc/*\/stat`;
 * Android has no `children` file).
 */
async function workersOf(pid: number): Promise<number[]> {
	const workers: number[] = [];
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
		const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		if (parent !== pid) continue;
		const command = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
		if (command.split("\0").some((arg) => /[/\\]worker\.(js|ts)$/.test(arg))) workers.push(Number(entry));
	}
	return workers;
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
	console.log(`${name.padEnd(48)}${value}`);
}
