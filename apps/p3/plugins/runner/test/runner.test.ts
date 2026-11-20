// The local runner against real processes. Its close (its plugin's object ends: a reload of the runner plugin, the
// server's close) stops every worker it runs at once, cleanly, forks nothing for a start it overtook, and is not held up
// by a start queued behind a worker that no longer answers; a rollout reaches a worker still starting (forked or not
// yet) once it is ready, and a change back behind one not answered yet; reloads settle when the worker exits; a stop
// suspends the session first, arms the kill once (also for a worker that said it leaves) and none for one that exited;
// an exit counts only once the server's store settled; a worker not ready within its start time fails its session,
// naming a predecessor that still holds the session's lock; a worker that exited leaves nothing behind. Most cases
// fork a stand-in worker (`stand-in.ts`) that speaks the control messages and is steered by the test over a socket;
// the session's lock forks the real worker (`WORKER`, the one import of p3's base).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type Link, Session } from "@earendil-works/p3/v1";
import type { PluginScript, ServerRuntime } from "@earendil-works/p3/v1/server";
import { WORKER } from "../../../src/install.ts";
import { collected, eventually } from "../../../test/until.ts";
import { LocalRunner } from "../local-runner.ts";

/** The stand-in worker's entry. */
const STAND_IN = fileURLToPath(new URL("./stand-in.ts", import.meta.url));

/** How long a stopping worker gets before it is killed (`worker-process.ts`). */
const GRACE_MS = 5000;

/** How long a worker may take to be ready, by default (`local-runner.ts`). */
const START_MS = 60_000;

/** A stand-in worker as the test sees it: what it reported, and a word to it. */
type StandIn = { next(): Promise<{ readonly event: string; readonly scripts: string }>; say(word: string): void };

/** A worker script set of one plugin whose digest is `digest`. */
function scriptsOf(digest: string): readonly PluginScript[] {
	// A stand-in's scripts: only the identity (`keyOf`) is read.
	return [{ plugin: { name: "p" }, built: { kind: "script", digest } }] as unknown as PluginScript[];
}

/** A session's address, as the route's stand-in reads it. */
type Addressed = { readonly params: { readonly id: string } };

/** A runner on a data directory of its own, its stand-ins' gate, what its route was asked. */
type Rig = {
	readonly runner: LocalRunner;
	/** What the runner reads at each use: a second runner on the same data directory takes it too. */
	readonly runtime: ServerRuntime;
	/** The worker scripts a start or a rollout reads; replace it to change them. */
	scripts: () => Promise<readonly PluginScript[]>;
	/** When the commits queued in the server's store settled (none are queued): replace it to hold an exit. */
	settled: () => Promise<void>;
	/** The route's `suspend` and `retry` calls, in order. */
	readonly route: string[];
	/** The next stand-in that connects to the gate. */
	standIn(): Promise<StandIn>;
	close(): Promise<void>;
};

/** A rig whose workers are stand-ins (or `worker`'s processes). */
async function rig(worker?: ServerRuntime["worker"]): Promise<Rig> {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-runner-"));
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
	const asked = (call: string, { params }: Addressed) =>
		route.push(`${call} ${params.id}: ${t.runner.state()[params.id]?.status ?? "none"}`);
	// A stand-in for the server's runtime: of its store the runner only waits for the queued commits.
	const runtime = {
		dataDir,
		store: { settled: () => t.settled() },
		worker: worker ?? { entry: STAND_IN, execArgv: [] },
		workerIdleMs: 60_000,
		workerScripts: () => t.scripts(),
		sessions: {
			suspend: (address: Addressed) => asked("suspend", address),
			retry: (address: Addressed) => asked("retry", address),
		},
	} as unknown as ServerRuntime;
	const t: Rig = {
		runner: new LocalRunner(() => runtime),
		runtime,
		scripts: async () => scriptsOf("1"),
		settled: async () => {},
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

/** The rollout step's reload, as an apply runs it: each host's result kind. */
async function rollout(t: Rig): Promise<{ readonly kind: string; readonly host: string }[]> {
	return (await t.runner.reload(undefined, context)).hosts.map(({ kind, host }) => ({ kind, host }));
}

/** Session `id`'s worker as `runner` sees it, once `done` holds for it. */
function stateOf(runner: LocalRunner, id: string, done: (status: string | undefined) => boolean) {
	return eventually(
		() => runner.state()[id],
		(state) => done(state?.status),
	);
}

/** A stand-in started and ready for session `id`: what it reported first, and the link to it. */
async function ready(t: Rig, id = "a"): Promise<{ readonly worker: StandIn; readonly link: Link }> {
	const link = await t.runner.start(Session({ id }), context);
	const worker = await t.standIn();
	await worker.next();
	worker.say("ready");
	await stateOf(t.runner, id, (status) => status === "running");
	return { worker, link };
}

/** The pid of session `id`'s worker, which runs. */
function pidOf(runner: LocalRunner, id: string): number {
	const state = runner.state()[id];
	return state?.status === "running" ? state.pid : assert.fail(JSON.stringify(state));
}

/** Whether process `pid` is stopped (`T` in `/proc/<pid>/stat`). */
async function stopped(pid: number): Promise<boolean> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
	return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
}

/** Whether `promise` settled within a few turns. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	const done = (): void => {
		settled = true;
	};
	promise.then(done, done);
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	return settled;
}

describe("the local runner's rollouts", () => {
	let t: Rig;
	beforeEach(async () => {
		t = await rig();
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
		assert.deepEqual(await applied, [{ kind: "reloaded", host: "a" }]);
		assert.deepEqual(await worker.next(), { event: "reload", scripts: "2" });
		// It runs the new scripts now: the next apply has nothing to ship.
		assert.deepEqual(await rollout(t), []);
	});

	it("an apply while a start has read the scripts but not forked yet reaches its worker (Sol B1, Astra B2)", async () => {
		const read = Promise.withResolvers<void>();
		const old = Promise.withResolvers<readonly PluginScript[]>();
		t.scripts = () => {
			read.resolve();
			return old.promise;
		};
		const started = t.runner.start(Session({ id: "a" }), context);
		await read.promise;
		t.scripts = async () => scriptsOf("2");
		const applied = rollout(t);
		old.resolve(scriptsOf("1"));
		await started;
		const worker = await t.standIn();
		assert.deepEqual(await worker.next(), { event: "start", scripts: "1" });
		worker.say("ready");
		assert.deepEqual(await applied, [{ kind: "reloaded", host: "a" }]);
		assert.deepEqual(await worker.next(), { event: "reload", scripts: "2" });
	});

	it("an apply back to what the worker runs, behind a change not answered yet, ships again (Astra B3)", async () => {
		await t.runner.start(Session({ id: "a" }), context);
		const worker = await t.standIn();
		await worker.next();
		t.scripts = async () => scriptsOf("2");
		const change = rollout(t);
		t.scripts = async () => scriptsOf("1");
		const revert = rollout(t);
		worker.say("ready");
		assert.deepEqual(await change, [{ kind: "reloaded", host: "a" }]);
		assert.deepEqual(await revert, [{ kind: "reloaded", host: "a" }]);
		assert.deepEqual(await worker.next(), { event: "reload", scripts: "2" });
		assert.deepEqual(await worker.next(), { event: "reload", scripts: "1" });
	});

	it("two reloads the worker's exit interrupts both settle", async () => {
		const { worker } = await ready(t);
		worker.say("mute");
		t.scripts = async () => scriptsOf("2");
		const first = rollout(t);
		t.scripts = async () => scriptsOf("3");
		const second = rollout(t);
		assert.deepEqual(await worker.next(), { event: "reload", scripts: "2" });
		worker.say("exit");
		for (const applied of [first, second]) assert.deepEqual(await applied, [{ kind: "failed", host: "a" }]);
		assert.equal(t.runner.state().a?.status, "failed");
	});
});

describe("the local runner's stops and exits", () => {
	let t: Rig;
	beforeEach(async () => {
		t = await rig();
	});
	afterEach(async () => {
		mock.restoreAll();
		mock.timers.reset();
		await t.close();
	});

	it("an exit counts once the server's store settled, its link closed first; the next start forks only then (Sol S2, S6)", async () => {
		const { worker, link } = await ready(t);
		const store = Promise.withResolvers<void>();
		t.settled = () => store.promise;
		let closed = false;
		link.onClose(() => {
			closed = true;
		});
		// A process of its own keeps the worker's channel open: only the runner's close of the link ends it.
		worker.say("orphan");
		const orphan = Number((await worker.next()).scripts);
		try {
			await eventually(
				() => closed,
				(done) => done,
			);
			assert.equal(t.runner.state().a?.status, "stopping", "not gone while the store has not settled");
			const next = t.runner.start(Session({ id: "a" }), context);
			assert.equal(await settledSoon(next), false, "the next start waits for the exit to count");
			store.resolve();
			await next;
			assert.deepEqual(await (await t.standIn()).next(), { event: "start", scripts: "1" });
		} finally {
			process.kill(orphan, "SIGKILL");
		}
	});

	it("a stop suspends the session before its worker stops, so its holders do not start it again", async () => {
		await ready(t);
		await t.runner.stop("a");
		assert.deepEqual(t.route, ["suspend a: running"]);
		assert.deepEqual(t.runner.state(), {});
		t.runner.retry("a");
		assert.deepEqual(t.route, ["suspend a: running", "retry a: none"]);
	});

	it("a stop after the worker exited, while its exit has not counted, arms no kill (Astra S3)", async () => {
		const { worker, link } = await ready(t);
		const pid = pidOf(t.runner, "a");
		const store = Promise.withResolvers<void>();
		t.settled = () => store.promise;
		let closed = false;
		link.onClose(() => {
			closed = true;
		});
		worker.say("exit");
		await eventually(
			() => closed,
			(done) => done,
		);
		const kill = mock.method(process, "kill");
		mock.timers.enable({ apis: ["setTimeout"] });
		const stopped = t.runner.stop("a");
		mock.timers.tick(GRACE_MS * 2);
		assert.deepEqual(
			kill.mock.calls.filter(({ arguments: [target] }) => target === -pid),
			[],
			"no kill of a process that exited",
		);
		store.resolve();
		await stopped;
	});

	it("a stop of a worker that said it leaves but stays is bounded: its group is killed after the grace (Astra S7)", async () => {
		const { worker } = await ready(t);
		const pid = pidOf(t.runner, "a");
		worker.say("linger");
		await stateOf(t.runner, "a", (status) => status === "stopping");
		const kill = mock.method(process, "kill");
		mock.timers.enable({ apis: ["setTimeout"] });
		const stopped = t.runner.stop("a");
		mock.timers.tick(GRACE_MS);
		assert.equal(kill.mock.calls.filter(({ arguments: [target] }) => target === -pid).length, 1);
		await stopped;
		assert.deepEqual(t.runner.state(), {});
	});

	it("a worker that exited by itself leaves nothing of it behind", async () => {
		const link = new WeakRef(await t.runner.start(Session({ id: "a" }), context));
		const worker = await t.standIn();
		worker.say("ready");
		worker.say("idle");
		await stateOf(t.runner, "a", (status) => status === undefined);
		assert.ok(await collected([link]), "the link is not kept by the session's queue");
	});
});

describe("the local runner's close", () => {
	let t: Rig;
	beforeEach(async () => {
		t = await rig();
	});
	afterEach(async () => {
		mock.timers.reset();
		await t.close();
	});

	it("a close while a start waits for the scripts forks nothing and does not wait for that start", async () => {
		const asked = Promise.withResolvers<void>();
		const scripts = Promise.withResolvers<readonly PluginScript[]>();
		t.scripts = () => {
			asked.resolve();
			return scripts.promise;
		};
		const started = t.runner.start(Session({ id: "a" }), context);
		await asked.promise;
		await t.runner.close();
		scripts.resolve(scriptsOf("1"));
		await assert.rejects(started, /the runner closed/);
		assert.deepEqual(t.runner.state(), {});
		await assert.rejects(t.runner.start(Session({ id: "b" }), context), /the runner closed/);
	});

	it("a close stops a worker that no longer answers while a start waits for its exit, and forks nothing (Sol B2, Astra S7)", async () => {
		const { worker } = await ready(t);
		worker.say("stubborn");
		// As the route resolves again after it lost the worker's link: the start waits for that worker's exit.
		const replacement = t.runner.start(Session({ id: "a" }), context);
		replacement.catch(() => {});
		await new Promise((resolve) => setImmediate(resolve));
		mock.timers.enable({ apis: ["setTimeout"] });
		const closing = t.runner.close();
		mock.timers.tick(GRACE_MS);
		await closing;
		await assert.rejects(replacement, /the runner closed/);
		assert.deepEqual(t.runner.state(), {});
	});

	it("a close stops a worker not ready yet and has the route resolve its session again, for the next runner", async () => {
		await t.runner.start(Session({ id: "a" }), context);
		await (await t.standIn()).next();
		await t.runner.close();
		assert.deepEqual(t.route, ["retry a: none"]);
	});
});

describe("the local runner's start time", () => {
	let t: Rig;
	beforeEach(async () => {
		t = await rig();
	});
	afterEach(async () => {
		mock.timers.reset();
		await t.close();
	});

	it("a worker not ready within its start time is killed and fails its session, named waiting for the lock", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		await t.runner.start(Session({ id: "a" }), context);
		// Started, never `locked`: as a worker waiting for its session's previous one.
		await t.standIn();
		mock.timers.tick(START_MS);
		mock.timers.reset();
		const state = await stateOf(t.runner, "a", (status) => status === "failed");
		assert.deepEqual(state, {
			status: "failed",
			reason:
				"did not start within 60 s: the session's previous worker still holds the session's lock (it has not exited)",
		});
	});
});

describe("the local runner with the real worker", () => {
	let t: Rig;
	beforeEach(async () => {
		t = await rig(WORKER);
		t.scripts = async () => [];
	});
	afterEach(async () => {
		mock.timers.reset();
		await t.close();
	});

	it("stops every worker it runs when it closes, and none of them counts as failed", async () => {
		for (const id of ["a", "b"]) await t.runner.start(Session({ id }), context);
		const pids: number[] = [];
		for (const id of ["a", "b"]) {
			const state = await stateOf(t.runner, id, (status) => status === "running");
			pids.push(state?.status === "running" ? state.pid : assert.fail(JSON.stringify(state)));
		}
		await t.runner.close();
		assert.deepEqual(t.runner.state(), {});
		for (const pid of pids) assert.throws(() => process.kill(pid, 0), "the worker process is gone");
	});

	it("a session's next worker waits for the previous one's lock, and says so when it times out (D2, Opus N4)", async () => {
		await t.runner.start(Session({ id: "a" }), context);
		await stateOf(t.runner, "a", (status) => status === "running");
		// A successor on the same data directory, as after a server's crash: the first runner's worker still runs.
		const successor = new LocalRunner(() => t.runtime, 1500);
		const next = new LocalRunner(() => t.runtime);
		try {
			await successor.start(Session({ id: "a" }), context);
			const failed = await stateOf(successor, "a", (status) => status === "failed");
			assert.match(
				failed?.status === "failed" ? failed.reason : "",
				/^did not start within 1.5 s: the session's previous worker still holds the session's lock/,
			);
			await next.start(Session({ id: "a" }), context);
			await t.runner.stop("a");
			await stateOf(next, "a", (status) => status === "running");
		} finally {
			await successor.close();
			await next.close();
		}
	});

	it("a worker that holds the session's lock but is not ready in time fails with its start time alone", async () => {
		// A worker plugin that stops its worker while it is evaluated: once the worker took the lock and opened its store.
		t.scripts = async () =>
			[
				{
					plugin: { name: "frozen", dir: t.runtime.dataDir, facets: { worker: "frozen.worker.ts" } },
					built: {
						kind: "script",
						plugin: "frozen",
						facet: "worker",
						source: '(function () { process.kill(process.pid, "SIGSTOP"); })',
						digest: "frozen",
					},
				},
			] as unknown as PluginScript[];
		mock.timers.enable({ apis: ["setTimeout"] });
		await t.runner.start(Session({ id: "a" }), context);
		const pid = (t.runner.state().a as { readonly pid: number }).pid;
		// Turns, not timers (they are mocked): until the worker stopped itself, and its `locked` was read meanwhile.
		const deadline = Date.now() + 30_000;
		while (!(await stopped(pid)) && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		mock.timers.tick(START_MS);
		mock.timers.reset();
		assert.deepEqual(await stateOf(t.runner, "a", (status) => status === "failed"), {
			status: "failed",
			reason: "did not start within 60 s",
		});
	});

	it("makes the locks directory private, also when it existed looser", async () => {
		await mkdir(join(t.runtime.dataDir, "locks"), { mode: 0o755 });
		await t.runner.start(Session({ id: "a" }), context);
		await stateOf(t.runner, "a", (status) => status === "running");
		assert.equal((await stat(join(t.runtime.dataDir, "locks"))).mode & 0o777, 0o700);
	});
});
