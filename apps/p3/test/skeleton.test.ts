// The skeleton end to end (ERNDL-954): the real server in this process, its session workers as real processes, a
// client signed in as the owner over WebSocket. One case per rule of the base, the runner and the sessions plugin.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context, until } from "@earendil-works/p3/v1";
import { WorkerRunners } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { askServer } from "../src/local-socket.ts";
import { Probe } from "./plugins/probe/contract.ts";
import {
	alive,
	coding,
	constantContract,
	constantPlugin,
	FAUX,
	gatedSession,
	openGate,
	PROBE,
	startRun,
} from "./support.ts";
import { eventually, within } from "./until.ts";

let running: TestServer | undefined;

/** The contract of the plugin the apply test writes (`versioned`): its value, on a session's worker. */
const Versioned = constantContract("versioned");

afterEach(async () => {
	await running?.close(context);
	running = undefined;
});

/** A server with one session; its id. */
async function withSession(): Promise<{ readonly t: TestServer; readonly id: string }> {
	running = await testServer({ plugins: [PROBE] }, context);
	const client = await running.client(context);
	const sessions = await client.get(Sessions, {}, context);
	return { t: running, id: await sessions.create(coding("one"), context) };
}

/** The probe on session `id`'s worker, held by a new owner client until `release`. */
async function probe(t: TestServer, id: string) {
	const client = await t.client(context);
	const held = await client.get(Probe, { session: id }, context);
	assert.equal(held.variant, "owner");
	return held as Extract<typeof held, { readonly variant: "owner" }>;
}

describe("session workers", () => {
	it("a worker starts on the first hold, as a process of its own, and follows its session's row", async () => {
		const { t, id } = await withSession();
		const worker = await (await t.client(context)).get(SessionWorker, { session: id }, context);
		assert.equal(worker.variant, "view");
		const pid = (await probe(t, id)).pid.value;
		assert.notEqual(pid, process.pid);
		assert.ok(alive(pid));
		const sessions = await (await t.client(context)).get(Sessions, {}, context);
		await sessions.rename({ session: id, title: "two" }, context);
		await until(worker.session, (row) => row?.title === "two", within("the renamed row", context));
	});

	it("a worker nobody holds stops itself after its idle time, cleanly", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		const pid = held.pid.value;
		held.release();
		await eventually(
			async () => alive(pid),
			(lives) => !lives,
		);
		// A clean exit: the session is not failed, and the next hold starts a new worker.
		assert.deepEqual(await t.workers(context), {});
		assert.notEqual((await probe(t, id)).pid.value, pid);
	});

	it("a worker with work in `WorkerBusy` stays alive unheld, and stops once it is done", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		const pid = held.pid.value;
		await held.busy(1, context);
		held.release();
		await sleep(t.idleMs * 4);
		assert.ok(alive(pid));
		const again = await probe(t, id);
		await again.busy(0, context);
		again.release();
		await eventually(
			async () => alive(pid),
			(lives) => !lives,
		);
	});

	it("a worker that crashes fails its session until retry", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		const pid = held.pid.value;
		await held.crash(context);
		await eventually(
			() => t.workers(context),
			(workers) => workers[id]?.status === "failed",
		);
		assert.ok(!alive(pid));
		const client = await t.client(context);
		await assert.rejects(client.get(Probe, { session: id }, context, { readyTimeout: 1000 }));
		(await t.host.registry(WorkerRunners, context)).value?.retry(id);
		assert.notEqual((await probe(t, id)).pid.value, pid);
	});

	it("a working session's worker starts again after a server restart, unasked", async (c) => {
		running = await testServer({ plugins: [PROBE, FAUX] }, context);
		const t = running;
		const folder = await mkdtemp(join(tmpdir(), "p3-skeleton-run-"));
		// The run waits on its gate on any worker; opened after the case, so no bash call waits on.
		c.after(async () => {
			await openGate(folder);
			await rm(folder, { recursive: true, force: true });
		});
		const client = await t.client(context);
		const id = await gatedSession(client, "one", folder, context);
		// The harness reports the run `working` (a report by the test would race the harness's own).
		await startRun(client, id, context);
		running = await t.restart(context);
		const restarted = running;
		await eventually(
			() => restarted.workers(context),
			(workers) => workers[id]?.status === "running",
		);
	});

	// Sol, review round 2 (S6): the case applied again and again until the code changed; now one apply per change,
	// once the watcher marked it, through the command `p3 apply` sends (D11).
	it("an apply ships a changed worker plugin to a running worker", async () => {
		const { t, id } = await withSession();
		const file = join(t.userRoot, "versioned.worker.ts");
		const client = await t.client(context);
		await writeFile(file, constantPlugin("versioned", "1"));
		await applied(t, (marks) => marks.set);
		const held = await client.get(Versioned, { session: id }, context);
		assert.equal(held.variant, "owner");
		if (held.variant !== "owner") return;
		assert.equal(held.value.value, "1");
		await writeFile(file, constantPlugin("versioned", "2"));
		await applied(t, (marks) => marks.dirty.length > 0);
		await until(held.value, (value) => value === "2", within("the applied value", context));
	});

	// Astra B1, review round 4, adapted to the decision (one runner, wraps): a plugin changing how workers run, added by
	// an apply while a worker is held, hid that worker from the status `p3 stop` kills by.
	it("the status names a held worker after an apply added a wrap, and the wrap's own workers beside it", async (c) => {
		const { t, id } = await withSession();
		const pid = (await probe(t, id)).pid.value;
		// A process the wrap says it runs elsewhere.
		const own = spawn("sleep", ["60"], { stdio: "ignore" });
		c.after(() => own.kill("SIGKILL"));
		await writeFile(join(t.userRoot, "elsewhere.server.ts"), wrapPlugin(own.pid!));
		await applied(t, (marks) => marks.set);
		const status = await askServer(t.dataDir, { kind: "status" }, 5000);
		assert.ok(status.kind === "answered" && status.answer.kind === "running", JSON.stringify(status));
		assert.deepEqual([...status.answer.workers].sort(), [pid, own.pid!].sort());
		assert.ok(alive(pid));
	});
});

/** A single-file server plugin contributing a wrap that runs everything on the runner beneath, and says it runs `pid`. */
function wrapPlugin(pid: number): string {
	return `import { defineFacet } from "@earendil-works/p3/v1";
import { WorkerRunnerWraps } from "@earendil-works/p3/v1/server";
export default defineFacet((_host, self) =>
	self.contribute(WorkerRunnerWraps, (inner) => ({
		start: (address, ctx) => inner.start(address, ctx),
		stop: (id) => inner.stop(id),
		retry: (id) => inner.retry(id),
		state: () => inner.state(),
		pids: () => [${pid}, ...inner.pids()],
		reload: (built, ctx) => inner.reload(built, ctx),
	})),
);
`;
}

/** Waits until the watcher's marks pass `marked`, then applies once with the command `apply`; asserts no step stopped. */
async function applied(t: TestServer, marked: (marks: typeof t.plugins.value) => boolean): Promise<void> {
	await until(t.plugins, marked, within("the watcher's marks", context, 10_000));
	const reply = await askServer(t.dataDir, { kind: "command", name: "apply" }, 60_000);
	assert.ok(reply.kind === "answered" && reply.answer.kind === "answer", JSON.stringify(reply));
	assert.equal((reply.answer.value as { readonly stopped: unknown }).stopped, null);
}

describe("the server", () => {
	it("closes once when asked twice at once, and frees its data directory for the next server", async () => {
		const first = await testServer({}, context);
		await Promise.all([first.stop(context), first.stop(context)]);
		running = await testServer({ dataDir: first.dataDir }, context);
		assert.notEqual(running.port, 0);
	});
});
