// The sessions plugin in the test topology (`topology.ts`): the owner's sessions and lists on the server, a worker per
// session that follows its row, who is refused, a session that does not exist, a restart on the same store, lists
// without a cap, and a reload of the plugin under an open list.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { P3Principal } from "@earendil-works/p3/v1";
import {
	CODING,
	SessionFacts,
	type SessionRow,
	Sessions,
	SessionsList,
	SessionWorker,
} from "../plugins/sessions/contract.ts";
import { PRINCIPALS } from "../src/app.ts";
import { type ServerStore, type Topology, topology } from "./topology.ts";
import { until } from "./until.ts";

const PERSON: P3Principal = { kind: "person", id: "max", name: "Max" };

const OWNER = PRINCIPALS.owner;

/** The coding app's active and archived lists, as one screen holds them. */
const ACTIVE = { app: CODING, set: "active", view: "test" } as const;
const ARCHIVED = { app: CODING, set: "archived", view: "test" } as const;

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

/** The owner's `Sessions` and active list on a client connected as the owner. */
async function ownerSessions(t: Topology) {
	const owner = await t.client(OWNER);
	const sessions = await owner.get(Sessions, {}, context);
	const active = await owner.get(SessionsList, ACTIVE, context);
	return { owner, sessions, active };
}

/** The ids of a list's rows, in order. */
function ids(list: { readonly rows: readonly SessionRow[] }): string[] {
	return list.rows.map((row) => row.id);
}

describe("the owner's sessions", () => {
	it("lists a created session and its worker follows its row", async () => {
		const t = await start();
		const { owner, sessions, active } = await ownerSessions(t);
		const id = await sessions.create({ title: "Plans" }, context);
		const [row] = active.list.value.rows;
		assert.deepEqual([row?.id, row?.title, row?.state, row?.archivedAt], [id, "Plans", "settled", null]);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		assert.deepEqual(worker.session.value, row);
		assert.deepEqual([...t.workers.keys()], [`session|${id}`]);
	});

	it("reaches the worker with a rename", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const id = await sessions.create({}, context);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		// Unnamed: each view shows its own "New session", in the viewer's language.
		assert.equal(worker.session.value?.title, "");
		await sessions.rename({ id, title: "Renamed" }, context);
		await until(worker.session, (session) => session?.title === "Renamed", context);
	});

	it("gives every session its own worker and row", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const a = await sessions.create({ title: "A" }, context);
		const b = await sessions.create({ title: "B" }, context);
		const workerA = await owner.get(SessionWorker, { session: a }, context);
		const workerB = await owner.get(SessionWorker, { session: b }, context);
		assert.deepEqual([workerA.session.value?.title, workerB.session.value?.title], ["A", "B"]);
		assert.equal(t.workers.size, 2);
	});

	it("archives and restores in the lists and in the worker's row", async () => {
		const t = await start();
		const { owner, sessions, active } = await ownerSessions(t);
		const archived = await owner.get(SessionsList, ARCHIVED, context);
		const id = await sessions.create({}, context);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		await sessions.archive({ id }, context);
		assert.deepEqual([ids(active.list.value), ids(archived.list.value)], [[], [id]]);
		await until(worker.session, (session) => session?.archivedAt !== null, context);
		await sessions.restore({ id }, context);
		assert.deepEqual([ids(active.list.value), ids(archived.list.value)], [[id], []]);
		await until(worker.session, (session) => session?.archivedAt === null, context);
	});

	it("refuses a rename of a session that does not exist", async () => {
		const t = await start();
		const { sessions, active } = await ownerSessions(t);
		await assert.rejects(sessions.rename({ id: "nope", title: "x" }, context), (error) =>
			isChordError(error, "invalid"),
		);
		assert.deepEqual(active.list.value.rows, []);
	});
});

describe("a list", () => {
	it("has no cap: `more` loads every session once, the last touched first", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		for (let i = 0; i < 201; i++) await sessions.create({ title: `s${i}` }, context);
		const list = await owner.get(SessionsList, { ...ACTIVE, view: "later" }, context);
		assert.deepEqual([list.list.value.rows.length, list.list.value.moreAfter], [50, true]);
		while (list.list.value.moreAfter) await list.more(context);
		const { rows } = list.list.value;
		assert.equal(new Set(ids({ rows })).size, 201);
		assert.ok(rows.every((row, index) => index === 0 || rows[index - 1]!.lastTouch >= row.lastTouch));
	});

	it("keeps its loaded rows when `more` adds a page, and shows a new session at the top", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		for (let i = 0; i < 120; i++) await sessions.create({ title: `s${i}` }, context);
		const list = await owner.get(SessionsList, { ...ACTIVE, view: "later" }, context);
		const first = list.list.value.rows;
		await list.more(context);
		const second = list.list.value.rows;
		assert.deepEqual([first.length, second.length], [50, 100]);
		// The same objects: only the new page crossed the link.
		assert.ok(first.every((row, index) => second[index] === row));
		// The new session is strictly the newest: the list orders by the time of the last touch.
		await new Promise((resolve) => setTimeout(resolve, 2));
		const id = await sessions.create({ title: "new" }, context);
		const third = (await until(list.list, ({ rows }) => rows.length === 101, context)).rows;
		assert.equal(third[0]?.id, id);
		assert.ok(second.every((row, index) => third[index + 1] === row));
	});

	it("moves a row from its last page to its first in one frame: the link stays open", async () => {
		// Review round 1 (Astra): both pages changed in one commit, the list's member was sent twice in one state
		// message, and the client closed the owner's link for the protocol error.
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		for (let i = 0; i < 51; i++) await sessions.archive({ id: await sessions.create({}, context) }, context);
		const archived = await owner.get(SessionsList, ARCHIVED, context);
		await archived.more(context);
		assert.equal(archived.list.value.rows.length, 51);
		const last = archived.list.value.rows.at(-1)!.id;
		// Archived again, strictly later: the last archived first.
		await new Promise((resolve) => setTimeout(resolve, 2));
		await sessions.archive({ id: last }, context);
		assert.deepEqual([archived.list.value.rows[0]?.id, archived.list.value.rows.length], [last, 51]);
		assert.equal(archived.state.value.kind, "live");
	});

	it("runs only the reads that show a renamed session", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const a = await sessions.create({ title: "A" }, context);
		const b = await sessions.create({ title: "B" }, context);
		const workerB = await owner.get(SessionWorker, { session: b }, context);
		await owner.get(SessionWorker, { session: a }, context);
		const before = [t.count("chord.query.runs"), t.count("chord.query.probes")];
		await sessions.rename({ id: a, title: "A2" }, context);
		// The list's page and session A's two reads (its worker's and its route's); B's are not run, and ask nothing.
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [3, 0]);
		assert.equal(workerB.session.value?.title, "B");
	});

	it("keeps its pages across a reload of the sessions plugin", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		for (let i = 0; i < 120; i++) await sessions.create({ title: `s${i}` }, context);
		const list = await owner.get(SessionsList, { ...ACTIVE, view: "later" }, context);
		await list.more(context);
		await list.more(context);
		const loaded = ids(list.list.value);
		assert.deepEqual([loaded.length, list.list.value.moreAfter], [120, false]);
		const worker = await owner.get(SessionWorker, { session: loaded[0]! }, context);
		const sizes: number[] = [];
		const watch = await list.list.watch(context);
		watch.start(async (call) => {
			if (call.kind === "value") sizes.push(call.value.rows.length);
		});
		await t.reloadSessions();
		await new Promise((resolve) => setTimeout(resolve, 2));
		const id = await sessions.create({ title: "after" }, context);
		await sessions.rename({ id: loaded[0]!, title: "renamed after" }, context);
		await until(list.list, ({ rows }) => rows[0]?.id === id && rows[1]?.title === "renamed after", context);
		await until(worker.session, (session) => session?.title === "renamed after", context);
		await watch.stop();
		assert.deepEqual(ids(list.list.value), [id, ...loaded]);
		// No frame showed fewer rows than were loaded: the successor opened the pages the list had.
		assert.ok(sizes.length > 0 && sizes.every((size) => size >= 120));
	});
});

describe("a reload of the worker's facet", () => {
	it("keeps the owner's hold of the session's worker: a rename after it still arrives", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const id = await sessions.create({ title: "Before" }, context);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		await t.reloadWorker(id);
		await sessions.rename({ id, title: "After the reload" }, context);
		await until(worker.session, (session) => session?.title === "After the reload", context);
		assert.equal(worker.state.value.kind, "live");
		assert.equal(t.workers.size, 1);
	});
});

describe("who is refused", () => {
	it("refuses a person the owner's sessions, lists and a session's worker", async () => {
		const t = await start();
		const { sessions } = await ownerSessions(t);
		const id = await sessions.create({}, context);
		const person = await t.client(PERSON);
		await assert.rejects(person.get(Sessions, {}, context), (error) => isChordError(error, "forbidden"));
		await assert.rejects(person.get(SessionsList, ACTIVE, context), (error) => isChordError(error, "forbidden"));
		await assert.rejects(person.get(SessionWorker, { session: id }, context), (error) =>
			isChordError(error, "forbidden"),
		);
		assert.equal(t.workers.size, 0);
	});

	it("refuses the server a session's worker as the owner sees it", async () => {
		const t = await start();
		const { sessions } = await ownerSessions(t);
		const id = await sessions.create({}, context);
		// The route lets the server reach the worker; the view is the owner's.
		await assert.rejects(t.server.get(SessionWorker, { session: id }, context), (error) =>
			isChordError(error, "forbidden"),
		);
		assert.equal(t.workers.size, 1);
	});

	it("gives a worker only its own session's row", async () => {
		const t = await start();
		const { sessions } = await ownerSessions(t);
		const a = await sessions.create({ title: "A" }, context);
		await sessions.create({ title: "B" }, context);
		const asA: P3Principal = { kind: "worker", session: a };
		const mine = await t.server.root(async (ctx) => (await ctx.get(SessionFacts, {})).session.value, context, {
			principal: asA,
		});
		assert.equal(mine?.title, "A");
		const unknown: P3Principal = { kind: "worker", session: "gone" };
		const none = await t.server.root(async (ctx) => (await ctx.get(SessionFacts, {})).session.value, context, {
			principal: unknown,
		});
		assert.equal(none, null);
	});

	it("starts no worker for a session that does not exist", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const id = await sessions.create({}, context);
		const unknown = owner.hold(SessionWorker, { session: "nope" }, context);
		await assert.rejects(owner.get(SessionWorker, { session: "nope" }, context), (error) =>
			isChordError(error, "forbidden"),
		);
		const state = unknown.state.value;
		assert.deepEqual(state.kind === "failed" && state.cause.kind, "denied");
		// A session that exists is reached beside it; the denied hold stays denied and no worker was made for it.
		await owner.get(SessionWorker, { session: id }, context);
		assert.deepEqual([...t.workers.keys()], [`session|${id}`]);
		assert.equal(unknown.state.value.kind, "failed");
	});
});

describe("a restart", () => {
	it("keeps the sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-sessions-"));
		directories.push(dir);
		const t = await start({ kind: "file", path: join(dir, "server.sqlite") });
		const first = await ownerSessions(t);
		const id = await first.sessions.create({ title: "Kept" }, context);
		await t.restart();
		const { owner, active } = await ownerSessions(t);
		assert.deepEqual(
			active.list.value.rows.map((row) => [row.id, row.title]),
			[[id, "Kept"]],
		);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		assert.equal(worker.session.value?.title, "Kept");
	});
});
