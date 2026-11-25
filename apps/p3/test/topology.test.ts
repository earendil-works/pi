// The topology tier (`test/topology.ts`): reloads of the plugins the skeleton touches while they are in use, and
// access: every object refuses the principals it does not serve.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { P3Principal } from "@earendil-works/p3/v1";
import { SessionFacts, SessionStart, Sessions, SessionsList, SessionWorker } from "../plugins/sessions/contract.ts";
import { SignIns } from "../plugins/sign-in/contract.ts";
import { Probe } from "./plugins/probe/contract.ts";
import { eventually } from "./support.ts";
import { type Topology, topology } from "./topology.ts";
import { until } from "./until.ts";

const OWNER: P3Principal = { kind: "owner" };
const PERSON: P3Principal = { kind: "person", id: "p1", name: "Ann" };

let running: Topology | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** A topology with one session and an owner client: the session's id. */
async function withSession(idleMs?: number) {
	const t = await topology(context, idleMs);
	running = t;
	const owner = await t.client(OWNER);
	const sessions = await owner.get(Sessions, {}, context);
	const id = await sessions.create({ title: "one" }, context);
	return { t, owner, sessions, id };
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("reloads while in use", () => {
	it("the sessions plugin on the server: an open list and a worker's row go on, a new session enters the list", async () => {
		const { t, owner, sessions, id } = await withSession();
		const list = await owner.get(SessionsList, { app: "coding", set: "active", view: "v1" }, context);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		await t.reload("@earendil-works/p3-sessions");
		const second = await sessions.create({ title: "two" }, context);
		await until(list.list, (value) => value.rows.some((row) => row.id === second), context);
		await sessions.rename({ id, title: "renamed" }, context);
		await until(worker.session, (row) => row?.title === "renamed", context);
		assert.deepEqual(t.errors, []);
	});

	it("the sessions plugin on a worker: its row still follows the server", async () => {
		const { t, owner, sessions, id } = await withSession();
		const worker = await owner.get(SessionWorker, { session: id }, context);
		await t.reload("@earendil-works/p3-sessions", id);
		await sessions.rename({ id, title: "renamed" }, context);
		await until(worker.session, (row) => row?.title === "renamed", context);
		assert.deepEqual(t.errors, []);
	});

	it("the sign-in plugin: issued sign-ins stay valid", async () => {
		const { t } = await withSession();
		const issued = await t.server.root(async (ctx) => {
			const signIns = await ctx.get(SignIns, {});
			return signIns.issue({ principal: OWNER, label: "test", kind: "device" }, ctx);
		}, context);
		await t.reload("@earendil-works/p3-sign-in");
		const verified = await t.server.root(
			async (ctx) => (await ctx.get(SignIns, {})).verify(issued.token, ctx),
			context,
		);
		assert.deepEqual(verified, OWNER);
	});

	it("the runner's worker facet: a worker still stops itself once idle", async () => {
		const { t, owner, id } = await withSession(200);
		const probe = await owner.get(Probe, { session: id }, context);
		await t.reload("@earendil-works/p3-runner", id);
		probe.release();
		await eventually(
			async () => t.closed,
			(closed) => closed.includes(id),
		);
	});
});

describe("access", () => {
	it("a person reaches none of the owner's objects", async () => {
		const { t, id } = await withSession();
		const person = await t.client(PERSON);
		await refused(person.get(Sessions, {}, context), "forbidden");
		await refused(person.get(SessionsList, { app: "coding", set: "active", view: "v" }, context), "forbidden");
		await refused(person.get(SessionWorker, { session: id }, context), "forbidden");
		await refused(person.get(Probe, { session: id }, context), "forbidden");
	});

	it("the owner reaches neither a worker's nor the waker's objects", async () => {
		const { owner, id } = await withSession();
		await refused(owner.get(SessionFacts, {}, context), "forbidden");
		await refused(owner.get(SessionStart, { session: id }, context), "forbidden");
	});

	it("a session's worker reaches its own row, never another session's worker", async () => {
		const { t, sessions, id } = await withSession();
		const other = await sessions.create({ title: "other" }, context);
		const worker = await t.client({ kind: "worker", session: id });
		const facts = await worker.get(SessionFacts, {}, context);
		assert.equal(facts.session.value?.id, id);
		await assert.rejects(worker.get(SessionWorker, { session: other }, context, { readyTimeout: 1000 }));
		assert.equal(t.workers.has(other), false, "no worker started for a refused principal");
	});
});
