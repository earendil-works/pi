// The local runner against real processes. Its close (its plugin's object ends: a reload of the runner plugin, the
// server's close) stops every worker it runs, cleanly, and forks nothing for a start it overtook; a rollout reaches a
// worker still starting once it is ready; reloads settle when the worker exits; a stop suspends the session first; a
// worker not ready within its start time fails its session; a worker that exited leaves nothing behind. Most cases fork
// a stand-in worker (`stand-in.mjs`) that speaks the control messages and is steered by the test over a socket; one
// forks the real worker (`WORKER`, the one import of p3's base).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { BACKGROUND_CONTEXT as context, Session } from "@earendil-works/p3/v1";
import type { PluginScript, ServerRuntime } from "@earendil-works/p3/v1/server";
import { WORKER } from "../../../src/install.ts";
import { LocalRunner, type LocalRunnerOptions } from "../local-runner.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** The stand-in worker's entry. */
const STAND_IN = fileURLToPath(new URL("./stand-in.mjs", import.meta.url));

/**
 * The first result of `probe` that passes `done`, tried every 10 ms; rejects after 10 s. For a worker
 * process's effects, which no watchable shows.
 */
async function polled<T>(probe: () => T, done: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = probe();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`polled: ${JSON.stringify(value)} did not pass`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A stand-in worker as the test sees it: what it reported, and a word to it. */
type StandIn = { next(): Promise<{ readonly event: string; readonly scripts: string }>; say(word: string): void };

/** A worker script set of one plugin whose digest is `digest`. */
function scriptsOf(digest: string): readonly PluginScript[] {
	// A stand-in's scripts: only the identity (`keyOf`) is read.
	return [{ plugin: { name: "p" }, built: { kind: "script", digest } }] as unknown as PluginScript[];
}

/** A runner on a data directory of its own, its stand-ins' gate, what its route was asked. */
type Bench = {
	readonly runner: LocalRunner;
	/** The worker scripts a start or a rollout reads; replace it to change them. */
	scripts: () => Promise<readonly PluginScript[]>;
	/** The route's `suspend` and `retry` calls, in order. */
	readonly route: string[];
	/** The next stand-in that connects to the gate. */
	standIn(): Promise<StandIn>;
	close(): Promise<void>;
};

/** A bench whose workers are stand-ins (or `worker`'s processes), started with `options`. */
async function bench(options: LocalRunnerOptions = {}, worker?: ServerRuntime["worker"]): Promise<Bench> {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-runner-"));
	// A stand-in for the server's store: the runner only waits for its queued commits, and none are queued here.
	const store = { settled: async () => {} } as ServerRuntime["store"];
	const arrivals: Socket[] = [];
	const waiting: ((socket: Socket) => void)[] = [];
	const gate: Server = createServer((socket) => {
		const waiter = waiting.shift();
		if (waiter !== undefined) waiter(socket);
		else arrivals.push(socket);
	});
	await new Promise<void>((resolve) => gate.listen(join(dataDir, "gate.sock"), resolve));
	const route: string[] = [];
	/** What the route was asked for session `id`, and what its worker was doing then. */
	const asked = (call: string, { params }: { readonly params: { readonly id: string } }) =>
		route.push(`${call} ${params.id}: ${t.runner.state()[params.id]?.status ?? "none"}`);
	const runtime = {
		dataDir,
		store,
		worker: worker ?? { entry: STAND_IN, execArgv: [] },
		workerIdleMs: 60_000,
		workerScripts: () => t.scripts(),
		sessions: { suspend: (address) => asked("suspend", address), retry: (address) => asked("retry", address) },
	} as Partial<ServerRuntime> as ServerRuntime;
	const t: Bench = {
		runner: new LocalRunner(() => runtime, options),
		scripts: async () => scriptsOf("1"),
		route,
		standIn: async () =>
			standInOf(arrivals.shift() ?? (await new Promise<Socket>((resolve) => waiting.push(resolve)))),
		close: async () => {
			await t.runner.close();
			await new Promise((resolve) => gate.close(resolve));
			await rm(dataDir, { recursive: true, force: true });
		},
	};
	return t;
}

/** The stand-in on `socket`: its lines in order. */
function standInOf(socket: Socket): StandIn {
	const lines: string[] = [];
	const waiting: ((line: string) => void)[] = [];
	let rest = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		const parts = (rest + chunk).split("\n");
		rest = parts.pop() ?? "";
		for (const line of parts) {
			const waiter = waiting.shift();
			if (waiter !== undefined) waiter(line);
			else lines.push(line);
		}
	});
	socket.on("error", () => {});
	return {
		next: async () => JSON.parse(lines.shift() ?? (await new Promise<string>((resolve) => waiting.push(resolve)))),
		say: (word) => socket.write(`${word}\n`),
	};
}

/** The rollout step's reload, as an apply runs it. */
function rollout(t: Bench) {
	return t.runner.reload(undefined, context);
}

describe("the local runner", () => {
	let t: Bench;
	beforeEach(async () => {
		t = await bench();
	});
	afterEach(() => t.close());

	it("an apply during a worker's start reaches it once it is ready, with the new scripts", async () => {
		await t.runner.start(Session({ id: "a" }), context);
		const worker = await t.standIn();
		assert.deepEqual(await worker.next(), { event: "start", scripts: "1" });
		t.scripts = async () => scriptsOf("2");
		const applied = rollout(t);
		// A turn: a reload shipped at once would reach the worker before its `ready`.
		await new Promise((resolve) => setImmediate(resolve));
		worker.say("ready");
		assert.deepEqual(
			(await applied).hosts.map(({ kind, host }) => ({ kind, host })),
			[{ kind: "reloaded", host: "a" }],
		);
		assert.deepEqual(await worker.next(), { event: "reload", scripts: "2" });
		// It runs the new scripts now: the next apply has nothing to ship.
		assert.deepEqual((await rollout(t)).hosts, []);
	});

	it("two reloads the worker's exit interrupts both settle", async () => {
		await t.runner.start(Session({ id: "a" }), context);
		const worker = await t.standIn();
		await worker.next();
		worker.say("mute");
		worker.say("ready");
		await polled(
			() => t.runner.state(),
			(state) => state.a?.status === "running",
		);
		t.scripts = async () => scriptsOf("2");
		const first = rollout(t);
		t.scripts = async () => scriptsOf("3");
		const second = rollout(t);
		assert.deepEqual(await worker.next(), { event: "reload", scripts: "2" });
		worker.say("exit");
		for (const applied of [first, second]) {
			assert.deepEqual(
				(await applied).hosts.map(({ kind, host }) => ({ kind, host })),
				[{ kind: "failed", host: "a" }],
			);
		}
		assert.equal(t.runner.state().a?.status, "failed");
	});

	it("a close while a start waits for the scripts forks nothing", async () => {
		const asked = Promise.withResolvers<void>();
		const scripts = Promise.withResolvers<readonly PluginScript[]>();
		t.scripts = () => {
			asked.resolve();
			return scripts.promise;
		};
		const started = t.runner.start(Session({ id: "a" }), context);
		await asked.promise;
		const closing = t.runner.close();
		scripts.resolve(scriptsOf("1"));
		await closing;
		await assert.rejects(started, /the runner closed/);
		assert.deepEqual(t.runner.state(), {});
		await assert.rejects(t.runner.start(Session({ id: "b" }), context), /the runner closed/);
	});

	it("a stop suspends the session before its worker stops, so its holders do not start it again", async () => {
		await t.runner.start(Session({ id: "a" }), context);
		const worker = await t.standIn();
		worker.say("ready");
		await polled(
			() => t.runner.state(),
			(state) => state.a?.status === "running",
		);
		await t.runner.stop("a");
		assert.deepEqual(t.route, ["suspend a: running"]);
		assert.deepEqual(t.runner.state(), {});
		t.runner.retry("a");
		assert.deepEqual(t.route, ["suspend a: running", "retry a: none"]);
	});

	it("a worker that exited by itself leaves nothing of it behind", async () => {
		const link = new WeakRef(await t.runner.start(Session({ id: "a" }), context));
		const worker = await t.standIn();
		worker.say("ready");
		worker.say("idle");
		await polled(
			() => t.runner.state(),
			(state) => state.a === undefined,
		);
		for (let i = 0; i < 10 && link.deref() !== undefined; i++) {
			await new Promise((resolve) => setImmediate(resolve));
			gc();
		}
		assert.equal(link.deref(), undefined, "the link is not kept by the session's queue");
	});
});

describe("the local runner's start time", () => {
	let t: Bench;
	beforeEach(async () => {
		t = await bench({ startMs: 200 });
	});
	afterEach(() => t.close());

	it("a worker not ready within its start time is killed and fails its session", async () => {
		await t.runner.start(Session({ id: "a" }), context);
		await t.standIn();
		const state = await polled(
			() => t.runner.state(),
			(state) => state.a?.status === "failed",
		);
		assert.deepEqual(state, { a: { status: "failed", reason: "did not start within 0.2 s" } });
	});
});

describe("the local runner with the real worker", () => {
	let t: Bench | undefined;
	after(() => t?.close());

	it("stops every worker it runs when it closes, and none of them counts as failed", async () => {
		t = await bench({}, WORKER);
		t.scripts = async () => [];
		for (const id of ["a", "b"]) await t.runner.start(Session({ id }), context);
		const running = await polled(
			() => t!.runner.state(),
			(state) => Object.values(state).every((each) => each.status === "running") && Object.keys(state).length === 2,
		);
		const pids = Object.values(running).map((each) =>
			each.status === "failed" ? assert.fail(each.reason) : each.pid,
		);
		await t.runner.close();
		assert.deepEqual(t.runner.state(), {});
		for (const pid of pids) assert.throws(() => process.kill(pid, 0), "the worker process is gone");
	});
});
