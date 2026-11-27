// The topology tier (`test/topology.ts`): reloads of the plugins the skeleton touches while they are in use, access
// (every object refuses the principals it does not serve), and the work a common action costs.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isChordError } from "@earendil-works/chord";
import {
	AppCatalog,
	BACKGROUND_CONTEXT as context,
	Environments,
	Me,
	type P3Principal,
	SessionFacts,
	SessionInfo,
	SessionStart,
	Sessions,
	SessionsList,
	SessionWorker,
	THIS_DEVICE,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, ServerCommands, SessionsStore } from "@earendil-works/p3/v1/server";
import { SignIns } from "../plugins/sign-in/contract.ts";
import { ThingsStore } from "../plugins/things/contract.server.ts";
import { Probe } from "./plugins/probe/contract.ts";
import { type Topology, topology } from "./topology.ts";
import { eventually, within } from "./until.ts";

const PERSON: P3Principal = { kind: "person", id: "p1", name: "Ann" };

/** Where the topology's sessions work. */
const HERE = { environment: THIS_DEVICE, folder: "/tmp" };

/** A new coding session titled `title`, as the owner makes it. */
function one(title: string) {
	return { app: "coding", title, location: HERE };
}

let running: Topology | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** A topology with one session and an owner client: the session's id. */
async function withSession(idleMs?: number) {
	const t = await topology(context, idleMs);
	running = t;
	const owner = await t.client(t.owner);
	const sessions = await owner.get(Sessions, {}, context);
	const id = await sessions.create(one("one"), context);
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
		assert.equal(list.state.value.kind, "live");
		assert.equal(worker.state.value.kind, "live");
		await t.reload("@earendil-works/p3-sessions");
		const second = await sessions.create(one("two"), context);
		await until(list.list, (value) => value.rows.some((row) => row.id === second), within("the second row", context));
		await sessions.rename({ session: id, title: "renamed" }, context);
		await until(worker.session, (row) => row?.title === "renamed", within("the renamed row", context));
		assert.deepEqual(t.errors, []);
	});

	it("the sessions plugin on the server: a list's loaded pages stay through a reload, and `more` goes on after it", async () => {
		const { t, owner, sessions } = await withSession();
		// 120 sessions: two pages of 50 loaded, a third to come.
		for (let i = 1; i < 120; i++) await sessions.create(one(`s${i}`), context);
		const list = await owner.get(SessionsList, { app: "coding", set: "active", view: "v1" }, context);
		await list.more(context);
		assert.deepEqual([list.list.value.rows.length, list.list.value.moreAfter], [100, true]);
		await t.reload("@earendil-works/p3-sessions");
		// A session made after the reload shows the new object's list: the new row on the first page, both pages kept.
		const after = await sessions.create(one("after"), context);
		const shown = await until(
			list.list,
			(value) => value.rows[0]?.id === after,
			within("the new first row", context),
		);
		assert.deepEqual([shown.rows.length, shown.moreAfter], [101, true]);
		await list.more(context);
		assert.deepEqual([list.list.value.rows.length, list.list.value.moreAfter], [121, false]);
		assert.equal(new Set(list.list.value.rows.map(({ id }) => id)).size, 121, "no row twice");
		assert.deepEqual(t.errors, []);
	});

	it("the sessions plugin on a worker: its row still follows the server", async () => {
		const { t, owner, sessions, id } = await withSession();
		const worker = await owner.get(SessionWorker, { session: id }, context);
		await t.reload("@earendil-works/p3-sessions", id);
		await sessions.rename({ session: id, title: "renamed" }, context);
		await until(worker.session, (row) => row?.title === "renamed", within("the renamed row", context));
		assert.deepEqual(t.errors, []);
	});

	it("the people, apps, environments, sessions and things plugins, reloaded in that order: a person's objects and the owner's go on", async () => {
		const { t, owner, sessions, id } = await withSession();
		const ann = await t.server.root(
			async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name: "Ann" }, ctx),
			context,
		);
		await sessions.addMember({ session: id, member: { kind: "person", id: ann, access: "read" } }, context);
		const person = await t.client({ kind: "person", id: ann, name: "Ann" });
		const me = await person.get(Me, {}, context);
		const catalog = await person.get(AppCatalog, {}, context);
		const access = await person.get(SessionInfo, { session: id }, context);
		const environments = await owner.get(Environments, {}, context);
		const coding = (apps: readonly { readonly id: string }[]) => apps.some(({ id: app }) => app === "coding");
		await until(catalog.apps, coding, within("her catalog", context));
		for (const plugin of ["people", "apps", "environments", "sessions", "things"])
			await t.reload(`@earendil-works/p3-${plugin}`);
		await t.server.root(
			async (ctx) => (await ctx.get(PeopleStore, {})).renamePerson({ person: ann, name: "Anna" }, ctx),
			context,
		);
		await until(me.me, (value) => value.kind === "person" && value.name === "Anna", within("the new name", context));
		await until(catalog.apps, coding, within("her catalog after the reloads", context));
		assert.equal(access.access.value, "read");
		assert.deepEqual(
			environments.environments.value.map(({ id: environment }) => environment),
			[THIS_DEVICE],
		);
		assert.deepEqual(t.errors, []);
	});

	for (const order of [
		["people", "apps", "things"],
		["people", "environments", "things", "sessions"],
		// Both, back to back: a things store started anew (lazily, by the environments plugin) is reloaded again.
		["people", "apps", "things", "people", "environments", "things", "sessions"],
	]) {
		it(`the ${order.join(", ")} plugins reloaded in that order (the owner bridge, ERNDL-1144): nothing reported`, async () => {
			const { t, owner } = await withSession();
			const me = await owner.get(Me, {}, context);
			// The first start's adoption of the people plugin's owner has committed.
			const id = t.owner.kind === "person" ? t.owner.id : "";
			const owners = () =>
				t.server.root(
					async (ctx) => (await (await ctx.get(ThingsStore, {})).persons.owners.page({}, 10, ctx)).items,
					context,
				);
			await eventually(owners, (items) => items.some(({ person }) => person === id));
			for (const plugin of order) await t.reload(`@earendil-works/p3-${plugin}`);
			await until(me.me, (value) => value.kind === "person" && value.owner, within("still the owner", context));
			assert.deepEqual(t.errors, []);
		});
	}

	it("the sign-in plugin: issued sign-ins stay valid", async () => {
		const { t } = await withSession();
		const issued = await t.server.root(async (ctx) => {
			const signIns = await ctx.get(SignIns, {});
			return signIns.issue({ principal: t.owner, label: "test", kind: "device" }, ctx);
		}, context);
		await t.reload("@earendil-works/p3-sign-in");
		const verified = await t.server.root(
			async (ctx) => (await ctx.get(SignIns, {})).verify(issued.token, ctx),
			context,
		);
		assert.deepEqual(verified, t.owner);
	});

	it("the sessions plugin's waker: a reload starts the worker of a working session nobody holds", async () => {
		const { t, id } = await withSession();
		await t.server.root(
			async (ctx) => (await ctx.get(SessionsStore, {})).report({ session: id, state: "working" }, ctx),
			context,
		);
		assert.equal(t.workers.has(id), false);
		await t.reload("@earendil-works/p3-sessions");
		await eventually(
			async () => t.workers.has(id),
			(started) => started,
		);
		assert.deepEqual(t.errors, []);
	});

	it("the control plugin: its commands `stop` and `apply` are there again", async () => {
		const { t } = await withSession();
		const commands = async () => {
			const served = (await t.server.registry(ServerCommands, context)).value;
			return ["stop", "apply"].map((name) => served.get(name) !== undefined);
		};
		assert.deepEqual(await commands(), [true, true]);
		await t.reload("@earendil-works/p3-control");
		assert.deepEqual(await commands(), [true, true]);
		assert.deepEqual(t.errors, []);
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
	it("a person reaches none of the owner's objects, and nothing of a session they are not in", async () => {
		const { t, id } = await withSession();
		const person = await t.client(PERSON);
		await refused(person.get(Sessions, {}, context), "forbidden");
		const list = await person.get(SessionsList, { app: "coding", set: "active", view: "v" }, context);
		assert.deepEqual(list.list.value.rows, []);
		await refused(person.get(SessionWorker, { session: id }, context, { readyTimeout: 1000 }), "forbidden");
		await refused(person.get(Probe, { session: id }, context, { readyTimeout: 1000 }), "forbidden");
		assert.equal(t.workers.has(id), false, "no worker started for a person outside the session");
	});

	it("the owner reaches neither a worker's nor the waker's objects", async () => {
		const { owner, id } = await withSession();
		await refused(owner.get(SessionFacts, {}, context), "forbidden");
		await refused(owner.get(SessionStart, { session: id }, context), "forbidden");
	});

	it("no worker starts for a session that does not exist", async () => {
		const { t, owner } = await withSession();
		await assert.rejects(owner.get(SessionWorker, { session: "none" }, context, { readyTimeout: 1000 }));
		assert.equal(t.workers.has("none"), false);
	});

	it("a session's worker reaches its own row, never another session's worker", async () => {
		const { t, sessions, id } = await withSession();
		const other = await sessions.create(one("other"), context);
		const worker = await t.client({ kind: "worker", session: id });
		const facts = await worker.get(SessionFacts, {}, context);
		assert.equal(facts.session.value?.id, id);
		await assert.rejects(worker.get(SessionWorker, { session: other }, context, { readyTimeout: 1000 }));
		assert.equal(t.workers.has(other), false, "no worker started for a refused principal");
	});
});

describe("counted work", () => {
	it("a rename runs only the reads that show the renamed session", async () => {
		const { t, owner, sessions, id: a } = await withSession();
		const b = await sessions.create(one("B"), context);
		await owner.get(SessionsList, { app: "coding", set: "active", view: "v" }, context);
		const workerB = await owner.get(SessionWorker, { session: b }, context);
		await owner.get(SessionWorker, { session: a }, context);
		const before = [t.count("chord.query.runs"), t.count("chord.query.probes")];
		await sessions.rename({ session: a, title: "A2" }, context);
		// The list's page and session A's row, which its worker and its route read as one shared read (Chord shares
		// identical live reads); B's run not, and ask nothing.
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [2, 0]);
		assert.equal(workerB.session.value?.title, "B");
	});

	it("a worker's report runs only the reads that show its session", async () => {
		const { t, owner, sessions, id: a } = await withSession();
		const b = await sessions.create(one("B"), context);
		const list = await owner.get(SessionsList, { app: "coding", set: "active", view: "v" }, context);
		await owner.get(SessionWorker, { session: b }, context);
		const probe = await owner.get(Probe, { session: a }, context);
		const before = [t.count("chord.query.runs"), t.count("chord.query.probes")];
		await probe.report({ state: "working" }, context);
		// As a rename: the list's page and session A's shared row read; B's not.
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [2, 0]);
		assert.equal(list.list.value.rows.find(({ id }) => id === a)?.state, "working");
	});

	// The route's admission and the worker's `admitSession` share one standing (the owner's person's: the session's row,
	// the person's row, their groups and the session's members); the worker's facts read only the session's row now (no
	// things feed, ERNDL-704), which is the standing's same live read, shared (Chord shares identical live reads,
	// ERNDL-1176): five runs.
	it("a hold of a session's worker costs five reads: the owner's standing and its worker's row; a second hold none", async () => {
		const { t, owner, id } = await withSession();
		await owner.get(SessionsList, { app: "coding", set: "active", view: "v" }, context);
		const counted = () => [t.count("chord.query.runs"), t.count("chord.query.probes")];
		const first = counted();
		await owner.get(SessionWorker, { session: id }, context);
		const second = counted();
		await (await t.client(t.owner)).get(SessionWorker, { session: id }, context);
		const after = counted();
		assert.deepEqual(
			[second[0]! - first[0]!, second[1]! - first[1]!, after[0]! - second[0]!, after[1]! - second[1]!],
			[5, 0, 0, 0],
		);
	});
});
