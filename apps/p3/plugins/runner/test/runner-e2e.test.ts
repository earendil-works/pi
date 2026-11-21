// The runner plugin on p3's real server (ERNDL-954, `testServer` of `/v1/testing`), reloaded and asked to stop. Its
// built-in plugins are copied into a root of the test's own, so the test edits the runner's server facet and applies it
// once the edit is marked, as an owner editing a plugin does. The old runner stops every worker, and the sessions
// plugin's waker starts the workers of the `working` sessions again on the new runner (an unheld session's run would
// otherwise stay cut off until a restart); the apply's worker step is the new runner's, so a worker plugin changed in
// the same apply reaches the worker the new runner started. A held session comes back by itself: the route's resolve
// waits for the next runner while there is none, starts again on it a start the old runner refused at its close, and
// resolves again a session whose worker the old runner stopped before its handshake. A stop keeps a held session
// stopped until `retry`.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, Sessions, until } from "@earendil-works/p3/v1";
import { type PluginScript, processLock, ServerRuntime, WorkerRunners } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { Probe } from "../../../test/plugins/probe/contract.ts";
import { alive, constantContract, constantPlugin, PROBE } from "../../../test/support.ts";
import { eventually, within } from "../../../test/until.ts";

/** The runner plugin's name, as its dirty mark names it. */
const RUNNER = "@earendil-works/p3-runner";

/** The worker plugin a test writes (`constantPlugin`) and its contract. */
const MARKED = "marked";
const Marked = constantContract(MARKED);

/** The checkout's built-in plugins, which a test copies. */
const BUILT_IN = fileURLToPath(new URL("../../", import.meta.url));

/** A test's server whose built-in plugins are a copy the test edits (`builtIn`). */
type EditableServer = { readonly t: TestServer; readonly builtIn: string };

let running: TestServer | undefined;

afterEach(async () => {
	await running?.close(context);
	running = undefined;
});

/** Starts a test's server (with the probe) on a new data directory with a copy of the built-in plugins (no tests). */
async function editableServer(): Promise<EditableServer> {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-e2e-"));
	const builtIn = join(dataDir, "builtin");
	await cp(BUILT_IN, builtIn, { recursive: true, filter: (path) => basename(path) !== "test" });
	running = await testServer({ dataDir, builtIn, plugins: [PROBE] }, context);
	return { t: running, builtIn };
}

/** A new session's id and an owner's client. */
async function newSession(t: TestServer) {
	const client = await t.client(context);
	const id = await (await client.get(Sessions, {}, context)).create({ title: "one" }, context);
	return { client, id };
}

/** A session that is `working`, its worker kept alive by its work and held by nobody: its id and the worker's pid. */
async function workingSession(t: TestServer): Promise<{ readonly id: string; readonly pid: number }> {
	const { client, id } = await newSession(t);
	const held = await client.get(Probe, { session: id }, context);
	if (held.variant !== "owner") return assert.fail(held.variant);
	const pid = held.pid.value;
	await held.report({ state: "working" }, context);
	await held.busy(1, context);
	held.release();
	return { id, pid };
}

/**
 * Edits the runner plugin's code (a comment would build the same script), waits until the plugins' marks show it (and
 * whatever `marked` asks for), applies once, and gives the new runner.
 */
async function reloadRunner(
	{ t, builtIn }: EditableServer,
	marked: (marks: typeof t.plugins.value) => boolean = () => true,
) {
	const before = (await t.host.registry(WorkerRunners, context)).value;
	const file = join(builtIn, "runner", "local-runner.ts");
	await writeFile(file, (await readFile(file, "utf8")).replace("the runner closed", "the runner was closed"));
	await until(
		t.plugins,
		(marks) => marks.dirty.includes(RUNNER) && marked(marks),
		within("the runner's edit marked", context, 10_000),
	);
	const result = await t.apply(context);
	assert.equal(result.stopped, undefined);
	// The apply restarted the runner's object: its successor is contributed once the old runner closed, after the apply.
	const runner = await until(
		await t.host.registry(WorkerRunners, context),
		(now) => now !== undefined && now !== before,
		within("the new runner", context, 10_000),
	);
	if (runner === undefined) return assert.fail("no runner");
	return runner;
}

describe("a reload of the runner plugin", () => {
	it("stops the workers, and the waker starts the unheld working session's worker again on the new runner", async () => {
		const editable = await editableServer();
		const { id, pid } = await workingSession(editable.t);
		const runner = await reloadRunner(editable);
		assert.ok(!alive(pid), "the old runner stopped its worker");
		const workers = await eventually(
			() => runner.state(),
			(state) => state[id]?.status === "running",
		);
		const restarted = workers[id];
		assert.ok(restarted?.status === "running" && restarted.pid !== pid);
		assert.deepEqual(editable.t.errors, []);
	});

	it("a held session comes back on a new worker, its holder's reference working again without a retry", async () => {
		const editable = await editableServer();
		const { t } = editable;
		const { client, id } = await newSession(t);
		const held = await client.get(Probe, { session: id }, context);
		if (held.variant !== "owner") return assert.fail(held.variant);
		const pid = held.pid.value;
		await reloadRunner(editable);
		await until(held.pid, (now) => now !== pid, within("the new worker's pid", context, 10_000));
		assert.ok(!alive(pid), "the old runner stopped its worker");
		assert.ok(alive(held.pid.value), "the holder's reference reaches the new worker");
		// A call on the same reference reaches the new worker.
		await held.busy(0, context);
		assert.deepEqual(t.errors, []);
	});

	it("a first hold whose start the old runner took before it was withdrawn starts on the new runner (Astra B4)", async () => {
		const editable = await editableServer();
		const { t } = editable;
		const runtime = (await t.host.registry(ServerRuntime, context)).value;
		const scripts = runtime.workerScripts;
		const read = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let first = true;
		// The old runner's start reads the scripts and waits there until the runner was replaced.
		runtime.workerScripts = async (ctx): Promise<readonly PluginScript[]> => {
			const current = await scripts(ctx);
			if (first) {
				first = false;
				read.resolve();
				await gate.promise;
			}
			return current;
		};
		const { client, id } = await newSession(t);
		const holding = client.get(Probe, { session: id }, context);
		await read.promise;
		try {
			await reloadRunner(editable);
		} finally {
			gate.resolve();
		}
		const held = await holding;
		assert.equal(held.variant, "owner");
		await held.busy(0, context);
		assert.deepEqual(t.errors, []);
	});

	it("a hold whose worker the old runner stopped before its handshake comes back on the new runner", async () => {
		const editable = await editableServer();
		const { t } = editable;
		const { client, id } = await newSession(t);
		// The session's lock held (the runner names it): its worker forks and waits for it, before it greets the server.
		const lock = await processLock(`p3-session:${join(t.dataDir, "workers", id)}`, context);
		const holding = client.get(Probe, { session: id }, context);
		holding.catch(() => {});
		try {
			await eventually(
				() => t.workers(context),
				(workers) => workers[id]?.status === "starting",
			);
			const runner = await reloadRunner(editable);
			await eventually(
				() => runner.state(),
				(state) => state[id]?.status === "starting",
			);
		} finally {
			await lock.release();
		}
		const held = await holding;
		assert.equal(held.variant, "owner");
		await held.busy(0, context);
	});

	it("an apply that also changes a worker plugin leaves the new runner's worker on the new worker scripts", async () => {
		const editable = await editableServer();
		const { t } = editable;
		await writeFile(join(t.userRoot, `${MARKED}.worker.ts`), constantPlugin(MARKED, "1"));
		const { id } = await workingSession(t);
		await writeFile(join(t.userRoot, `${MARKED}.worker.ts`), constantPlugin(MARKED, "2"));
		// A plugin no discovery knew yet marks the set; one it knew, itself.
		await reloadRunner(editable, ({ dirty, set }) => set || dirty.includes(MARKED));
		const held = await (await t.client(context)).get(Marked, { session: id }, context);
		if (held.variant !== "owner") return assert.fail(held.variant);
		await until(held.value, (value) => value === "2", within("the new worker script's value", context));
	});
});

describe("a stop of a held session", () => {
	it("keeps its worker stopped until retry; its holder's reference then reaches a new worker (Sol S6)", async () => {
		const t = await testServer({ plugins: [PROBE] }, context);
		running = t;
		const { client, id } = await newSession(t);
		const held = await client.get(Probe, { session: id }, context);
		if (held.variant !== "owner") return assert.fail(held.variant);
		const pid = held.pid.value;
		const runner = (await t.host.registry(WorkerRunners, context)).value;
		if (runner === undefined) return assert.fail("no runner");
		await runner.stop(id);
		assert.ok(!alive(pid), "the worker stopped");
		const failed = await until(
			held.state,
			(state) => state.kind === "failed",
			within("the hold failing", context, 10_000),
		);
		assert.ok(failed.kind === "failed" && failed.cause.kind === "waiting");
		assert.match(failed.cause.error.message, /suspended/);
		assert.equal((await t.workers(context))[id], undefined, "nothing started it again");
		runner.retry(id);
		await until(held.pid, (now) => now !== pid, within("the new worker's pid", context, 10_000));
		await held.busy(0, context);
	});
});
