// The skeleton end to end (ERNDL-954): the real server in this process, its session workers as real processes, a
// client signed in as the owner over WebSocket. One case per rule of the base, the runner and the sessions plugin.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { WorkerRunners } from "@earendil-works/p3/v1/server";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { askServer } from "../src/local-socket.ts";
import { Probe } from "./plugins/probe/contract.ts";
import { alive, constantContract, constantPlugin, IDLE_MS, type TestServer, testServer } from "./support.ts";
import { eventually, until } from "./until.ts";

let running: TestServer | undefined;

/** The contract of the plugin the apply test writes (`versioned`): its value, on a session's worker. */
const Versioned = constantContract("versioned");

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** A server with one session; its id. */
async function withSession(): Promise<{ readonly t: TestServer; readonly id: string }> {
	running = await testServer();
	const client = await running.client();
	const sessions = await client.get(Sessions, {}, context);
	return { t: running, id: await sessions.create({ title: "one" }, context) };
}

/** The probe on session `id`'s worker, held by a new owner client until `release`. */
async function probe(t: TestServer, id: string) {
	const client = await t.client();
	const held = await client.get(Probe, { session: id }, context);
	assert.equal(held.variant, "owner");
	return held as Extract<typeof held, { readonly variant: "owner" }>;
}

describe("session workers", () => {
	it("a worker starts on the first hold, as a process of its own, and follows its session's row", async () => {
		const { t, id } = await withSession();
		const worker = await (await t.client()).get(SessionWorker, { session: id }, context);
		assert.equal(worker.variant, "owner");
		const pid = (await probe(t, id)).pid.value;
		assert.notEqual(pid, process.pid);
		assert.ok(alive(pid));
		const sessions = await (await t.client()).get(Sessions, {}, context);
		await sessions.rename({ id, title: "two" }, context);
		if (worker.variant !== "owner") return;
		await until(worker.session, (row) => row?.title === "two", context);
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
		assert.deepEqual(await t.workers(), {});
		assert.notEqual((await probe(t, id)).pid.value, pid);
	});

	it("a worker with work in `WorkerBusy` stays alive unheld, and stops once it is done", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		const pid = held.pid.value;
		await held.busy(1, context);
		held.release();
		await sleep(IDLE_MS * 4);
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
			() => t.workers(),
			(workers) => workers[id]?.status === "failed",
		);
		assert.ok(!alive(pid));
		const client = await t.client();
		await assert.rejects(client.get(Probe, { session: id }, context, { readyTimeout: 1000 }));
		(await t.server.runtime.host.registry(WorkerRunners, context)).value?.retry(id);
		assert.notEqual((await probe(t, id)).pid.value, pid);
	});

	it("a working session's worker starts again after a server restart, unasked", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		await held.report({ state: "working" }, context);
		await held.busy(1, context);
		running = await t.restart();
		const restarted = running;
		await eventually(
			() => restarted.workers(),
			(workers) => workers[id]?.status === "running",
		);
	});

	// Sol, review round 2 (S6): the case applied again and again until the code changed; now one apply per change,
	// once the watcher marked it, through the command `p3 apply` sends (D11).
	it("an apply ships a changed worker plugin to a running worker", async () => {
		const { t, id } = await withSession();
		const file = join(t.plugins, "versioned.worker.ts");
		const client = await t.client();
		await writeFile(file, constantPlugin("versioned", "1"));
		await applied(t, (marks) => marks.set);
		const held = await client.get(Versioned, { session: id }, context);
		assert.equal(held.variant, "owner");
		if (held.variant !== "owner") return;
		assert.equal(held.value.value, "1");
		await writeFile(file, constantPlugin("versioned", "2"));
		await applied(t, (marks) => marks.dirty.length > 0);
		await until(held.value, (value) => value === "2", context);
	});
});

/** Waits until the watcher's marks pass `marked`, then applies once with the command `apply`; asserts no step stopped. */
async function applied(t: TestServer, marked: (marks: typeof t.server.plugins.value) => boolean): Promise<void> {
	await until(t.server.plugins, marked, context, 10_000);
	const reply = await askServer(t.dataDir, { kind: "command", name: "apply" }, 60_000);
	assert.ok(reply.kind === "answered" && reply.answer.kind === "answer", JSON.stringify(reply));
	assert.equal((reply.answer.value as { readonly stopped: unknown }).stopped, null);
}

describe("the server", () => {
	it("closes once when asked twice at once, and frees its data directory for the next server", async () => {
		const first = await testServer();
		await Promise.all([first.server.close(context), first.server.close(context)]);
		running = await testServer({ dataDir: first.dataDir });
		assert.notEqual(running.server.port, 0);
	});
});
