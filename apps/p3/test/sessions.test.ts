// The sessions plugin in the test topology (`topology.ts`): the owner's sessions on the server, a worker per session
// that follows its facts, who is refused, a restart on the same store, and the bounded list.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { P3Principal } from "@p3/app/v1";
import { SessionFacts, Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { PRINCIPALS } from "../src/app.ts";
import { type ServerStore, type Topology, topology } from "./topology.ts";
import { until } from "./until.ts";

const PERSON: P3Principal = { kind: "person", id: "max", name: "Max" };

const OWNER = PRINCIPALS.owner;

let running: Topology | undefined;
/** Temporary directories of this test, removed after it (once its topology closed). */
const directories: string[] = [];
afterEach(async () => {
	const errors = running?.errors ?? [];
	await running?.close();
	running = undefined;
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
	// Nothing failed in the background but the refusals a test asked for (a factory refusing reports its activation).
	const refusal = (error: (typeof errors)[number]) =>
		error.kind === "activation_failed" && isChordError(error.failure.error, "forbidden");
	assert.deepEqual(
		errors.filter((error) => !refusal(error)),
		[],
	);
});

/** A topology for this test, closed after it. */
async function start(store?: ServerStore): Promise<Topology> {
	running = await topology(context, store);
	return running;
}

/** The owner's `Sessions` on a client connected as the owner. */
async function ownerSessions(t: Topology) {
	const owner = await t.client(OWNER);
	const sessions = await owner.get(Sessions, {}, context);
	return { owner, sessions };
}

describe("the owner's sessions", () => {
	it("lists a created session and its worker follows its facts", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const id = await sessions.create({ title: "Plans" }, context);
		const [row] = await until(sessions.list, (list) => list.length === 1, context);
		assert.deepEqual(
			{ ...row, createdAt: 0 },
			{
				id,
				title: "Plans",
				app: "coding",
				creator: { kind: "owner" },
				createdAt: 0,
				archivedAt: null,
			},
		);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		const { id: _, ...info } = row!;
		assert.deepEqual(worker.facts.value.session, info);
		assert.deepEqual([...t.workers.keys()], [`session|${id}`]);
	});

	it("reaches the worker with a rename", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const id = await sessions.create({}, context);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		// Unnamed: each view shows its own "New session", in the viewer's language.
		assert.equal(worker.facts.value.session?.title, "");
		await sessions.rename({ id, title: "Renamed" }, context);
		await until(worker.facts, (facts) => facts.session?.title === "Renamed", context);
	});

	it("gives every session its own worker and facts", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const a = await sessions.create({ title: "A" }, context);
		const b = await sessions.create({ title: "B" }, context);
		const workerA = await owner.get(SessionWorker, { session: a }, context);
		const workerB = await owner.get(SessionWorker, { session: b }, context);
		assert.equal(workerA.facts.value.session?.title, "A");
		assert.equal(workerB.facts.value.session?.title, "B");
		assert.equal(t.workers.size, 2);
	});

	it("archives and restores the row and the facts together", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const id = await sessions.create({}, context);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		await sessions.archive({ id }, context);
		assert.notEqual(sessions.list.value[0]?.archivedAt, null);
		await until(worker.facts, (facts) => facts.session?.archivedAt !== null, context);
		await sessions.restore({ id }, context);
		assert.equal(sessions.list.value[0]?.archivedAt, null);
		await until(worker.facts, (facts) => facts.session?.archivedAt === null, context);
	});

	it("refuses a rename of a session that does not exist", async () => {
		const t = await start();
		const { sessions } = await ownerSessions(t);
		await assert.rejects(sessions.rename({ id: "nope", title: "x" }, context), (error) =>
			isChordError(error, "invalid"),
		);
	});

	it("keeps the newest 200 in the list", async () => {
		const t = await start();
		const { sessions } = await ownerSessions(t);
		const first = await sessions.create({ title: "first" }, context);
		// The first is strictly the oldest: the list orders by creation time.
		await new Promise((resolve) => setTimeout(resolve, 2));
		for (let i = 0; i < 200; i++) await sessions.create({ title: `s${i}` }, context);
		const list = await until(
			sessions.list,
			(rows) => rows.length === 200 && !rows.some((row) => row.id === first),
			context,
		);
		assert.equal(list.length, 200);
	});
});

describe("who is refused", () => {
	it("refuses a person the owner's sessions and a session's worker", async () => {
		const t = await start();
		const { sessions } = await ownerSessions(t);
		const id = await sessions.create({}, context);
		const person = await t.client(PERSON);
		await assert.rejects(person.get(Sessions, {}, context), (error) => isChordError(error, "forbidden"));
		await assert.rejects(person.get(SessionWorker, { session: id }, context), (error) =>
			isChordError(error, "forbidden"),
		);
		assert.equal(t.workers.size, 0);
	});

	it("gives a worker only its own session's facts", async () => {
		const t = await start();
		const { sessions } = await ownerSessions(t);
		const a = await sessions.create({ title: "A" }, context);
		await sessions.create({ title: "B" }, context);
		const asA: P3Principal = { kind: "worker", session: a };
		const facts = await t.server.root(async (ctx) => (await ctx.get(SessionFacts, {})).facts.value, context, {
			principal: asA,
		});
		assert.equal(facts.session?.title, "A");
		const unknown: P3Principal = { kind: "worker", session: "gone" };
		const none = await t.server.root(async (ctx) => (await ctx.get(SessionFacts, {})).facts.value, context, {
			principal: unknown,
		});
		assert.equal(none.session, null);
	});
});

describe("a restart", () => {
	it("keeps the sessions and their facts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-sessions-"));
		directories.push(dir);
		const t = await start({ kind: "file", path: join(dir, "server.sqlite") });
		const first = await ownerSessions(t);
		const id = await first.sessions.create({ title: "Kept" }, context);
		await t.restart();
		const { owner, sessions } = await ownerSessions(t);
		assert.equal(sessions.list.value[0]?.title, "Kept");
		const worker = await owner.get(SessionWorker, { session: id }, context);
		assert.equal(worker.facts.value.session?.title, "Kept");
	});
});
