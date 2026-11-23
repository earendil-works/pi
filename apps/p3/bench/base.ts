// What the base adds over the skeleton (`docs/base.md`), measured as `bench/skeleton.ts` measures, with p3 launched as
// its owner starts it:
// - the page: the time of the first `GET /` after a launch (it builds the page's base bundle and the web plugins),
//   warm `GET /` beside it, the server's USS settled before and after it, and the page's files as the page links
//   them (the base script, the plugins' combined file, the stylesheets), their bytes and gzipped;
// - a session with the harness and its things (the Pi's coding tools and faux login, which every session following
//   the owner has; `test/plugins/faux-login` copied to the data directory's user root, its script set per session):
//   its worker's start until its first object (`SessionWorker`) and until its transcript's view arrived (Durable
//   open), the idle worker's USS settled, one faux answer with a tool call (bash) from send to the row's `settled`,
//   and the worker's USS settled after it.
// Times are medians of 20 runs with min and max, the first (cold) run apart; USS the median of the 21 workers.
// Run from apps/p3, with Node 26: node --conditions=source --disable-warning=ExperimentalWarning bench/base.ts
// [--release <dir>]: with it, the release `npm run release:p3:local -- --out <dir>` installed in `<dir>/install` runs.
// Every launched server is stopped however the bench ends (`launched.ts`).

import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
	BACKGROUND_CONTEXT as context,
	type Host,
	type P3Principal,
	type SessionState,
	SessionsList,
	THIS_DEVICE,
	Transcript,
	until,
} from "@earendil-works/p3/v1";
import { ownerClient, ownerCookie } from "@earendil-works/p3/v1/testing";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { COMMAND } from "../src/install.ts";
import { FauxRequests, type Step } from "../test/plugins/faux-login/contract.ts";
import { childrenOf, scriptFaux } from "../test/support.ts";
import { within } from "../test/until.ts";
import { launchTracked, withServer } from "./launched.ts";

/** Node's arguments that run the `p3` command: the release installed in `--release`, else this checkout's source. */
const { release } = parseArgs({ options: { release: { type: "string" } } }).values;
const P3 =
	release === undefined
		? COMMAND
		: [join(release, "install", "node_modules", "@earendil-works", "p3", "dist", "p3.js")];
console.log(`p3 from ${release === undefined ? "source" : `the release in ${release}`}, Node ${process.versions.node}`);

/** How many warm launches and sessions are measured (the cold first comes on top). */
const RUNS = 20;

/** The faux login plugin, copied into each data directory's user root. */
const FAUX = fileURLToPath(new URL("../test/plugins/faux-login/", import.meta.url));

/** The faux login's script: a bash call for `@go`, then text for the tool's result. */
const SCRIPT: Step[] = [
	{ when: "@go", reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command: "echo hi" }) }] },
	{ when: "", reply: [{ kind: "text", text: "done" }] },
];

const root = await mkdtemp(join(tmpdir(), "p3-bench-base-"));
const env =
	release === undefined
		? { ...process.env, NODE_COMPILE_CACHE: undefined }
		: { ...process.env, NODE_COMPILE_CACHE: join(root, "compile-cache") };
try {
	const builds: number[] = [];
	const warm: number[] = [];
	for (let i = 0; i <= RUNS; i++) {
		const dataDir = await dataDirWithFaux(join(root, `launch-${i}`));
		await withServer(await launchTracked(P3, dataDir, env), async (server) => {
			const cookie = await ownerCookie(server.dataDir, server.port, context);
			builds.push((await page(server.port, cookie)).ms);
			warm.push((await page(server.port, cookie)).ms);
		});
	}
	line("page: first GET / after a launch, cold (first)", `${builds[0]!.toFixed(0)} ms`);
	line("page: first GET / after a launch (builds)", stats(builds.slice(1)));
	line("page: a second GET /", stats(warm.slice(1), 1));

	const server = await launchTracked(P3, await dataDirWithFaux(join(root, "pi")), env);
	try {
		line("server, settled, before any page", `USS ${mib(await settled(server.pid))}`);
		const cookie = await ownerCookie(server.dataDir, server.port, context);
		const { html } = await page(server.port, cookie);
		line("server, settled, after one GET /", `USS ${mib(await settled(server.pid))}`);
		for (const [what, path] of files(html)) {
			const bytes = Buffer.from(await (await get(server.port, path, cookie)).arrayBuffer());
			line(`page file: ${what}`, `${kib(bytes.length)}, gzip ${kib(gzipSync(bytes).length)}`);
		}

		const client = await ownerClient(server.dataDir, server.port, context, 30_000);
		const sessions = await client.get(Sessions, {}, context);
		const workerStarts: number[] = [];
		const starts: number[] = [];
		const ids: string[] = [];
		const held: { release(): void }[] = [];
		for (let i = 0; i <= RUNS; i++) {
			const folder = join(root, `folder-${i}`);
			await mkdir(folder);
			// The session follows the owner, so it has the Pi's coding tools and faux login ("in all my sessions").
			const id = await sessions.create(
				{ app: "coding", title: `s${i}`, location: { environment: THIS_DEVICE, folder } },
				context,
			);
			await scriptFaux(client, id, SCRIPT, context);
			const started = performance.now();
			held.push(await client.get(SessionWorker, { session: id }, context));
			workerStarts.push(performance.now() - started);
			const transcript = await client.get(Transcript, { session: id }, context);
			await until(transcript.view, (view) => view !== null, within("the transcript", context, 30_000));
			starts.push(performance.now() - started);
			ids.push(id);
			held.push(transcript);
		}
		line("harness worker: start to its first object, the first", `${workerStarts[0]!.toFixed(0)} ms`);
		line("harness worker: start to its first object, warm", stats(workerStarts.slice(1)));
		line("harness worker: start to its transcript, the first", `${starts[0]!.toFixed(0)} ms`);
		line("harness worker: start to its transcript, warm", stats(starts.slice(1)));
		const pids = await workerPids(server.pid, ids.length);
		line(`harness worker, idle, settled (median of ${pids.length})`, `USS ${mib(median(await settledAll(pids)))}`);

		const answers: number[] = [];
		for (const id of ids) {
			const started = performance.now();
			await send(client, id, "@go");
			await reaches(client, id, "settled");
			answers.push(performance.now() - started);
		}
		await ranTheTool(client, ids[0]!);
		line("faux answer with a tool call, send to settled, the first", `${answers[0]!.toFixed(0)} ms`);
		line("faux answer with a tool call, send to settled", stats(answers.slice(1)));
		line(
			`harness worker, after the answer, settled (median of ${pids.length})`,
			`USS ${mib(median(await settledAll(pids)))}`,
		);
		line(`server, settled, ${ids.length} harness workers`, `USS ${mib(await settled(server.pid))}`);
		for (const each of held) each.release();
		await client.close(context);
	} finally {
		await server.stop();
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

/** `path` made a data directory whose user root holds the faux login plugin. */
async function dataDirWithFaux(path: string): Promise<string> {
	await cp(FAUX, join(path, "plugins", "faux-login"), { recursive: true });
	return path;
}

/** `GET path` on the server at `port` with `cookie`; throws unless it answered 200. */
async function get(port: number, path: string, cookie: string): Promise<Response> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie } });
	if (!response.ok) throw new Error(`bench: GET ${path} answered ${response.status}`);
	return response;
}

/** The time of `GET /` until its whole body arrived, and the body. */
async function page(port: number, cookie: string): Promise<{ ms: number; html: string }> {
	const started = performance.now();
	const html = await (await get(port, "/", cookie)).text();
	return { ms: performance.now() - started, html };
}

/** The files the page links of its own (the surface's scripts and stylesheets), by what they are. */
function files(html: string): [string, string][] {
	const found: [string, string][] = [];
	for (const [, tag, path] of html.matchAll(/<(script|link)[^>]*(?:src|href)="(\/_chord\/web\/[^"]+)"/g)) {
		found.push([`${tag === "script" ? "script" : "stylesheet"} ${path}`, path!]);
	}
	return found;
}

/** Sends `text` to `session`'s transcript as the owner. */
async function send(client: Host<P3Principal>, session: string, text: string): Promise<void> {
	await client.root(async (ctx) => {
		const transcript = await ctx.get(Transcript, { session });
		if (transcript.variant !== "writer") throw new Error("bench: the owner does not write");
		await transcript.send({ text, requestId: text }, ctx);
	}, context);
}

/** Throws unless `session`'s faux login got the bash call's result, with bash offered: the answer ran the tool. */
async function ranTheTool(client: Host<P3Principal>, session: string): Promise<void> {
	const requests = await client.root(
		async (ctx) => (await ctx.get(FauxRequests, { session })).requests.value,
		context,
	);
	const result = requests[1];
	if (requests.length !== 2 || !result?.matched || !result.tools.includes("bash") || !result.last.includes("hi")) {
		throw new Error(`bench: the answer did not run bash: ${JSON.stringify(requests)}`);
	}
}

/** Waits until `session`'s row in the owner's list is in `state`. */
async function reaches(client: Host<P3Principal>, session: string, state: SessionState): Promise<void> {
	await client.root(async (ctx) => {
		const list = await ctx.get(SessionsList, { app: "coding", set: "active", view: `state-${state}` });
		await until(
			list.list,
			(value) => value.rows.find((row) => row.id === session)?.state === state,
			within(`the row ${state}`, ctx, 30_000),
		);
	}, context);
}

/** The pids of the server's session workers; throws unless there are `count`. */
async function workerPids(server: number, count: number): Promise<number[]> {
	const workers = (await childrenOf(server)).filter(({ args }) =>
		args.some((arg) => /[/\\]worker\.(js|ts)$/.test(arg)),
	);
	if (workers.length !== count) throw new Error(`bench: ${workers.length} workers run, not ${count}`);
	return workers.map(({ pid }) => pid);
}

/** The settled USS of each of `pids`, read at once. */
function settledAll(pids: readonly number[]): Promise<number[]> {
	return Promise.all(pids.map((pid) => settled(pid)));
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

function stats(values: readonly number[], digits = 0): string {
	const ms = (value: number) => value.toFixed(digits);
	return `median ${ms(median(values))} ms (min ${ms(Math.min(...values))}, max ${ms(Math.max(...values))}, n ${values.length})`;
}

function mib(kib: number): string {
	return `${(kib / 1024).toFixed(1)} MiB`;
}

function kib(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

function line(name: string, value: string): void {
	console.log(`${name.padEnd(64)}${value}`);
}
