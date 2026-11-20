// p3's numbers (`docs/slices/01-base-and-sessions.md` and `26-release.md`, Numbers). Two parts:
// 1. A launched server, as a user starts it: from the source checkout, or with `--release <install directory>` the
//    installed release. Process launch to listening (cold: an empty compile cache; warm), what the start spends on
//    building plugins and the worker base, the server's memory, a session worker's start (cold: the first after the
//    server's start; warm) and what idle workers need (`RssAnon`, USS: the memory no other process shares, PSS), and
//    the owner's list over the WebSocket at 1,000, 10,000 and 100,000 sessions. Then the commands on a named Pi:
//    plain `p3` (a background start), `p3` again (the server found), `status`, `stop`, and the supervisor's memory.
// 2. Source only, in this process: where the list's time goes. Beside a trivial call and a trivial object on the same
//    link (the round trip alone), the same without a link (on the server's host), the store's page reads alone, and a
//    CPU profile of opens and `more`s by where the time goes.
// Run from apps/p3: node --conditions=source --disable-warning=ExperimentalWarning bench/slice-1.ts [--release <dir>]

import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Session as Inspector } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Contract, Host, ParamsOf, Reference } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { int, method, type P3Principal, remote, Server, str } from "@earendil-works/p3/v1";
import { SessionsStore } from "../plugins/sessions/contract.server.ts";
import { CODING, Sessions, SessionsList, SessionWorker } from "../plugins/sessions/contract.ts";
import { PRINCIPALS } from "../src/app.ts";
import { startP3 } from "../src/bootstrap/server.ts";
import { ownerClient } from "../test/client.ts";
import { type Launched, launch, releaseOf, run as runCommand, SOURCE } from "../test/launched.ts";

/** How often each list measurement runs: its median is reported. */
const RUNS = 30;

/** The list's sizes. */
const SIZES = [1000, 10_000, 100_000];

/** The coding app's active list as screen `view` holds it. */
const listOf = (view: string) => ({ app: CODING, set: "active", view }) as const;

/** The ping plugin's object (`PING_PLUGIN`): nothing behind it, so a call or a hold of it is the round trip alone. */
const Ping = remote("bench.ping", {
	version: 1,
	params: { view: str() },
	hostAddress: () => Server(),
	variants: { any: { state: { value: int() }, methods: { ping: method() } } },
});

/** A single-file plugin serving `Ping`: its contract is the one above, written again (the two must stay equal). */
const PING_PLUGIN = [
	'import { constant, defineFacet, int, method, remote, Server, str } from "@earendil-works/p3/v1";',
	'const Ping = remote("bench.ping", { version: 1, params: { view: str() }, hostAddress: () => Server(),',
	"\tvariants: { any: { state: { value: int() }, methods: { ping: method() } } } });",
	"export default defineFacet((host) =>",
	'\thost.serve(Ping, () => ({ variant: "any", members: { value: constant(0), ping: async () => null } })));',
].join("\n");

/** A process's memory in MiB: anonymous, unique to it (USS) and its proportional share (PSS). */
async function memory(pid: number | "self"): Promise<{ rssAnon: number; uss: number; pss: number }> {
	const status = await readFile(`/proc/${pid}/status`, "utf8");
	const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
	const kb = (text: string, field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(text)?.[1]);
	return {
		rssAnon: kb(status, "RssAnon") / 1024,
		uss: (kb(rollup, "Private_Clean") + kb(rollup, "Private_Dirty")) / 1024,
		pss: kb(rollup, "Pss") / 1024,
	};
}

/** The median of `values`. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/** How long `work` takes, in ms, and what it gave. */
async function timed<T>(work: () => Promise<T>): Promise<[number, T]> {
	const at = performance.now();
	const value = await work();
	return [performance.now() - at, value];
}

/** Prints one result line. */
function line(what: string, value: string): void {
	console.log(`${what.padEnd(50)}${value}`);
}

/** How often a launch is measured cold and warm. */
const LAUNCHES = 5;

/** The ms of the start step `what` in a server's `NODE_DEBUG=p3` output, once it printed it. */
async function startStep(server: Launched, what: string): Promise<number> {
	for (let waited = 0; waited < 10_000; waited += 20) {
		const found = new RegExp(`${what} in (\\d+) ms`).exec(server.stderr());
		if (found !== null) return Number(found[1]);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`the server did not report "${what}"`);
}

/**
 * Part 1: the server launched with `command`. Its launch, cold and warm; what its start builds; its memory; a
 * worker's start and memory; the list over the WebSocket.
 */
async function launched(command: readonly string[], dir: string): Promise<void> {
	let run = 0;
	/** Launches on a data directory of its own with Node's compile cache in `cache`; its start steps reported. */
	const start = (cache: string) => {
		const env = { ...process.env, NODE_COMPILE_CACHE: cache, NODE_DEBUG: "p3" };
		return launch(command, join(dir, `data-${run++}`), { env, cwd: dir });
	};
	const cold: number[] = [];
	const warm: number[] = [];
	const plugins: number[] = [];
	const base: number[] = [];
	for (let i = 0; i < LAUNCHES; i++) {
		// Cold: a compile cache nobody filled. Warm: the same cache again.
		const cache = join(dir, `compile-cache-${i}`);
		for (const times of [cold, warm]) {
			const server = await start(cache);
			times.push(server.listening);
			if (times === warm) {
				plugins.push(await startStep(server, "server plugins built and loaded"));
				base.push(await startStep(server, "worker base built"));
			}
			await server.close();
		}
	}
	line(
		"process launch to listening, cold",
		`${median(cold).toFixed(0)} ms (an empty compile cache; median of ${LAUNCHES})`,
	);
	line("process launch to listening, warm", `${median(warm).toFixed(0)} ms (median of ${LAUNCHES})`);
	line(
		"  of it: server plugins built and loaded",
		`${median(plugins).toFixed(0)} ms (every start; nothing built is kept)`,
	);
	line("  after it: the worker base built", `${median(base).toFixed(0)} ms (every start)`);

	const server = await start(join(dir, "compile-cache-0"));
	try {
		const client = await ownerClient(server, context);
		const sessions = await client.get(Sessions, {}, context);
		/** Creates a session and holds its worker: how long from the hold to live. */
		const workerStart = async () => {
			const id = await sessions.create({}, context);
			return (await timed(() => client.get(SessionWorker, { session: id }, context)))[0];
		};
		const first = await workerStart();
		const next: number[] = [];
		for (let i = 0; i < 10; i++) next.push(await workerStart());
		// Idle: give the workers a moment after their first answer.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const own = await memory(server.pid);
		// The ten started last: the eleven run at once.
		const workers = await Promise.all((await server.workers()).slice(-10).map(memory));
		const total = (field: "rssAnon" | "uss" | "pss") => workers.reduce((sum, each) => sum + each[field], 0);
		const mib = (value: number) => `${value.toFixed(1)} MiB`;
		line("server, alone", `RssAnon ${mib(own.rssAnon)}, USS ${mib(own.uss)}`);
		line("worker start, cold", `${first.toFixed(0)} ms (the first: its plugins built, its code compiled)`);
		line("worker start, warm", `${median(next).toFixed(0)} ms (median of 10)`);
		line("an idle worker, RssAnon", `${mib(median(workers.map((each) => each.rssAnon)))} (median of 10)`);
		line("an idle worker, USS", `${mib(median(workers.map((each) => each.uss)))} (median of 10)`);
		line(
			`${workers.length} idle workers at once, PSS`,
			`${mib(total("pss"))} (${(total("pss") / workers.length).toFixed(1)} each)`,
		);
		// Settled: V8's memory reducer has run by then (mem-audit: a worker shows 28 MiB at 1 s, 24 at 40 s).
		await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
		const settled = await Promise.all((await server.workers()).slice(-10).map(memory));
		line("server, settled (40 s)", `USS ${mib((await memory(server.pid)).uss)}`);
		line("an idle worker, USS, settled (40 s)", `${mib(median(settled.map((each) => each.uss)))} (median of 10)`);
		line("the worker base", `${((await baseBytes(server.dataDir)) / 1024).toFixed(0)} KiB (what a worker loads)`);
		const overWire: Getter = (Type, params) => client.get(Type, params, context);
		let made = 11;
		for (const size of SIZES) {
			await fill(client, made, size);
			made = size;
			const { open, more } = await listCost(overWire, `launched-${size}`);
			line(`the list at ${size}: open, more`, `${open.toFixed(2)} ms, ${more.toFixed(2)} ms`);
		}
		await client.close(context);
	} finally {
		await server.close();
	}
}

/** How long a process is left before its settled memory is read. */
const SETTLE_MS = 40_000;

/** The bytes of the worker base Chord's workers component wrote into `dataDir` (`cache/worker/`). */
async function baseBytes(dataDir: string): Promise<number> {
	const dir = join(dataDir, "cache", "worker");
	const files = await readdir(dir, { recursive: true, withFileTypes: true });
	const sizes = await Promise.all(
		files
			.filter((file) => file.isFile() && !file.name.endsWith(".map"))
			.map((file) => stat(join(file.parentPath, file.name))),
	);
	return sizes.reduce((sum, { size }) => sum + size, 0);
}

/** How often each command is measured. */
const COMMANDS = 20;

/**
 * Part 1, the commands of `command` on a named Pi under a home directory in `dir`, the compile cache warm: how long
 * each takes from its launch to its exit, and what the background server's supervisor needs.
 */
async function commands(command: readonly string[], dir: string): Promise<void> {
	const home = join(dir, "home");
	await mkdir(home);
	const env = { ...process.env, HOME: home, NODE_COMPILE_CACHE: join(dir, "compile-cache-0") };
	const p3 = async (...args: string[]) => {
		const [ms, ran] = await timed(() => runCommand(command, [...args, "--pi", "bench"], { env, cwd: dir }));
		if (ran.code !== 0) throw new Error(`p3 ${args.join(" ")}: ${ran.stdout}${ran.stderr}`);
		return ms;
	};
	const times: Record<"start" | "found" | "status" | "stop", number[]> = {
		start: [],
		found: [],
		status: [],
		stop: [],
	};
	let supervisor = 0;
	for (let i = 0; i <= COMMANDS; i++) {
		const start = await p3();
		const found = await p3();
		const status = await p3("status");
		const record = join(home, ".pi", "p3", "pis", "bench", "supervisor.json");
		const { pid } = JSON.parse(await readFile(record, "utf8")) as { pid: number };
		supervisor = (await memory(pid)).uss;
		const stop = await p3("stop");
		// The first round is the Pi's first start (its directory made, its port taken): not counted.
		if (i > 0)
			for (const [name, ms] of Object.entries({ start, found, status, stop })) times[name as "start"].push(ms);
	}
	// The supervisor once more, settled.
	await p3();
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	const record = join(home, ".pi", "p3", "pis", "bench", "supervisor.json");
	const settled = (await memory((JSON.parse(await readFile(record, "utf8")) as { pid: number }).pid)).uss;
	await p3("stop");
	const ms = (values: number[]) => `${median(values).toFixed(0)} ms (median of ${COMMANDS})`;
	line("p3: a background start, to its owner link", ms(times.start));
	line("p3 again: the running server's fresh link", ms(times.found));
	line("p3 status", ms(times.status));
	line("p3 stop, until the directory is free", ms(times.stop));
	line("the supervisor, USS", `${supervisor.toFixed(1)} MiB; settled (40 s) ${settled.toFixed(1)} MiB`);
}

/** A `get` of a client over the WebSocket, or of a scope on the server's host. */
type Getter = <C extends Contract>(Type: C, params: ParamsOf<C>) => Promise<Reference<C>>;

/** Creates sessions until there are `count`, 250 calls at a time. */
async function fill(client: Host<P3Principal>, from: number, count: number): Promise<void> {
	const sessions = await client.get(Sessions, {}, context);
	for (let made = from; made < count; made += 250) {
		const batch = Array.from({ length: Math.min(250, count - made) }, (_, i) => `session ${made + i}`);
		await Promise.all(batch.map((title) => sessions.create({ title }, context)));
	}
	sessions.release();
}

/** Opens the list `RUNS` times with `get`, each a screen of its own: the medians of the open and of one `more`. */
async function listCost(get: Getter, name: string): Promise<{ open: number; more: number }> {
	const open: number[] = [];
	const more: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const [opened, list] = await timed(() => get(SessionsList, listOf(`${name}-${i}`)));
		open.push(opened);
		more.push((await timed(() => list.more(context)))[0]);
		list.release();
	}
	return { open: median(open), more: median(more) };
}

/** The round trip alone with `get`: the medians of a trivial call and of holding a trivial object. */
async function pingCost(get: Getter, name: string): Promise<{ call: number; hold: number }> {
	const call: number[] = [];
	const hold: number[] = [];
	const ping = await get(Ping, { view: name });
	for (let i = 0; i < RUNS; i++) {
		call.push((await timed(() => ping.ping(context)))[0]);
		const [held, other] = await timed(() => get(Ping, { view: `${name}-${i}` }));
		hold.push(held);
		other.release();
	}
	ping.release();
	return { call: median(call), hold: median(hold) };
}

/** The store's reads alone on the server's host: the medians of the first page and of the page after its bookmark. */
async function pageCost(server: Host<P3Principal>): Promise<{ first: number; after: number }> {
	const store = await server.get(SessionsStore, {}, context);
	const first: number[] = [];
	const after: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const [took, page] = await timed(() => store.sessions.active.page({ app: CODING }, 51, context));
		first.push(took);
		const next = { after: page.next! };
		after.push((await timed(() => store.sessions.active.page({ app: CODING }, 51, context, next)))[0]);
	}
	store.release();
	return { first: median(first), after: median(after) };
}

/** How many opens and `more`s the profile covers. */
const PROFILED = 200;

/** Where a profile's frame belongs: by its file, or by its name for the VM's own frames (no file). */
const PARTS: readonly (readonly [string, RegExp])[] = [
	["SQLite: the statements", /^ (all|get|run|prepare|iterate|exec)$|^node:sqlite/],
	["the store: reads, row decoding, skip test", /\/chord\/src\/(sqlite|store)\//],
	["the plugin's mapping of rows", /@earendil-works\/p3-sessions\//],
	["the list: pages, bookmarks, readers", /\/host\/(list|tiling|named-query|query-reader|read-declarations)\.ts/],
	["objects: activation, references, admission", /\/chord\/src\/(host|registries|documents|state|context)\//],
	[
		"the link: encoding, decoding, Delta, replicas",
		/\/chord\/src\/(link|delta|remote|data|contracts)\/|\/schema\/src\//,
	],
	["WebSocket and socket I/O", /node_modules\/ws\/|undici|^ (writev|writeBuffer|encodeInto|decodeUTF8)$|^node:/],
	["garbage collector", /^ \(garbage collector\)$/],
];

/**
 * Profiles `PROFILED` opens and `more`s over the WebSocket: the CPU time of one open and one `more` together (server
 * and client: they share this process), in ms by part. Idle time and the profiler's own are left out.
 */
async function profile(get: Getter): Promise<readonly (readonly [string, number])[]> {
	const inspector = new Inspector();
	inspector.connect();
	await inspector.post("Profiler.enable");
	await inspector.post("Profiler.setSamplingInterval", { interval: 50 });
	await inspector.post("Profiler.start");
	for (let i = 0; i < PROFILED; i++) {
		const list = await get(SessionsList, listOf(`profile-${i}`));
		await list.more(context);
		list.release();
	}
	const { profile } = await inspector.post("Profiler.stop");
	inspector.disconnect();
	const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
	const parts = new Map<string, number>();
	for (const [index, id] of (profile.samples ?? []).entries()) {
		const { url, functionName } = frames.get(id)!;
		if (functionName === "(idle)" || url === "node:inspector") continue;
		const part = PARTS.find(([, pattern]) => pattern.test(`${url} ${functionName}`))?.[0] ?? "other";
		parts.set(part, (parts.get(part) ?? 0) + (profile.timeDeltas?.[index] ?? 0));
	}
	return [...parts].map(([part, micros]) => [part, micros / 1000 / PROFILED] as const).sort((a, b) => b[1] - a[1]);
}

/** Part 2 (source, in this process): the owner's list at each size, over the WebSocket and on the server's host. */
async function lists(dir: string): Promise<void> {
	// The sessions plugin and the ping plugin in a root of the bench's own.
	const root = join(dir, "plugins");
	await mkdir(root);
	await cp(fileURLToPath(new URL("../plugins/sessions/", import.meta.url)), join(root, "sessions"), {
		recursive: true,
	});
	await writeFile(join(root, "ping.server.ts"), PING_PLUGIN);
	const app = await startP3(context, { dataDir: join(dir, "lists"), root, port: 0, onStop: () => {} });
	try {
		const client = await ownerClient(app, context);
		const overWire: Getter = (Type, params) => client.get(Type, params, context);
		const ms = (value: number) => `${value.toFixed(2)} ms`;
		let made = 0;
		for (const size of SIZES) {
			const [filled] = await timed(() => fill(client, made, size));
			line(`\n${size} sessions`, `(${((filled * 1000) / (size - made)).toFixed(0)} µs a create, 250 at a time)`);
			if (made === 0) {
				const [open, list] = await timed(() => overWire(SessionsList, listOf("cold")));
				const [more] = await timed(() => list.more(context));
				list.release();
				line("  the first open and more after the start", `${ms(open)}, ${ms(more)} (cold code)`);
			}
			made = size;
			const wire = await listCost(overWire, `wire-${size}`);
			const ping = await pingCost(overWire, `wire-${size}`);
			const local = await app.host.root(
				async (ctx) => {
					const onHost: Getter = (Type, params) => ctx.get(Type, params);
					return { list: await listCost(onHost, `local-${size}`), ping: await pingCost(onHost, `local-${size}`) };
				},
				context,
				{ principal: PRINCIPALS.owner },
			);
			const pages = await pageCost(app.host);
			line("  over the WebSocket: open, more", `${ms(wire.open)}, ${ms(wire.more)}`);
			line("  over the WebSocket: trivial hold, call", `${ms(ping.hold)}, ${ms(ping.call)}`);
			line("  on the server's host: open, more", `${ms(local.list.open)}, ${ms(local.list.more)}`);
			line("  on the server's host: trivial hold, call", `${ms(local.ping.hold)}, ${ms(local.ping.call)}`);
			line("  the store's page of 51: first, after it", `${ms(pages.first)}, ${ms(pages.after)}`);
		}
		console.log(`\nCPU time of one open and one more over the WebSocket at ${made} sessions, server and client:`);
		const parts = await profile(overWire);
		for (const [part, each] of parts) line(`  ${part}`, ms(each));
		line("  all", ms(parts.reduce((sum, [, each]) => sum + each, 0)));
		await client.close(context);
	} finally {
		await app.close(context);
	}
}

const { values } = parseArgs({ options: { release: { type: "string" } } });
const dir = await mkdtemp(join(tmpdir(), "p3-bench-"));
try {
	if (values.release === undefined) {
		console.log("p3 from source");
		await launched(SOURCE, dir);
		await commands(SOURCE, dir);
		console.log("\nthe list's cost, in this process");
		await lists(dir);
	} else {
		console.log(`p3 release (${values.release})`);
		await launched(releaseOf(values.release), dir);
		await commands(releaseOf(values.release), dir);
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}
