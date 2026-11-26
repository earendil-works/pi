// The topology tier (`test/topology.ts`): reloads of the plugins the skeleton touches while they are in use, access
// (every object refuses the principals it does not serve), and the work a common action costs.

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
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
	ThisDevice,
	until,
} from "@earendil-works/p3/v1";
import { Http, PeopleStore, type Router, ServerCommands, SessionsStore } from "@earendil-works/p3/v1/server";
import { MachineHosts, TerminalHosts } from "../plugins/environments/contract.server.ts";
import { MACHINE_KIND } from "../plugins/environments/contract.ts";
import { Machine } from "../plugins/environments/kind.ts";
import { seeded } from "../plugins/environments/test/seeded.ts";
import { DOWNLOAD_PATH, Files, FilesKind, UPLOAD_PATH } from "../plugins/files/contract.ts";
import { SignIns } from "../plugins/sign-in/contract.ts";
import { ATTACH_PATH, Terminals, TerminalsKind } from "../plugins/terminals/contract.ts";
import { OneThing, ThingsStore } from "../plugins/things/contract.server.ts";
import { Probe } from "./plugins/probe/contract.ts";
import { type Topology, topology } from "./topology.ts";
import { collected, eventually, within } from "./until.ts";

const PERSON: P3Principal = { kind: "person", id: "p1", name: "Ann" };

/** A new coding session titled `title`, as the owner makes it (on this device, in a folder of its own). */
function one(title: string) {
	return { app: "coding", title };
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

/** The handlers of the files and terminals plugins' routes in the HTTP component's router. */
function routes(router: Router): object[] {
	const paths = [`GET ${DOWNLOAD_PATH}`, `PUT ${UPLOAD_PATH}`, `GET ${ATTACH_PATH}`];
	return paths.map((key) => {
		const [method, path] = key.split(" ") as [string, string];
		const match = router.route(method, path);
		assert.ok(match !== undefined && match !== "bad_path", key);
		return match.handler;
	});
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

	it("the files and terminals plugins: a person's Files and Terminals go on", async () => {
		const t = await topology(context);
		running = t;
		// A person put into Pi, whom its defaults give Files and Terminals.
		const [pi, files, terminals, machine, ann] = await t.server.root(async (ctx) => {
			const things = await ctx.get(ThingsStore, {});
			const one = async (kind: string) => await seeded(await ctx.get(OneThing, { kind }), ctx);
			const root = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
			const by = { kind: "plugin", plugin: "test" } as const;
			const person = await things.createPerson({ name: "Ann", madeBy: by }, ctx);
			await things.putParty({ workspace: root, party: { kind: "person", person }, source: by }, ctx);
			return [root, await one(FilesKind.name), await one(TerminalsKind.name), await one(MACHINE_KIND), person];
		}, context);
		const person = await t.client({ kind: "person", id: ann, name: "Ann" });
		const browser = await person.get(Files, { workspace: pi, thing: files }, context);
		const panes = await person.get(Terminals, { workspace: pi, thing: terminals }, context);
		await browser.entries!({ machine, path: tmpdir() }, context);
		await t.reload("@earendil-works/p3-files");
		await until(browser.state, (state) => state.kind === "live", within("Files again", context));
		await browser.entries!({ machine, path: tmpdir() }, context);
		await t.reload("@earendil-works/p3-terminals");
		await until(panes.state, (state) => state.kind === "live", within("Terminals again", context));
		// This device's terminals are pending (its `openPty` refuses): the list is what goes on, empty.
		await until(panes.terminals!, (list) => list.length === 0, within("the list", context));
		assert.deepEqual(t.errors, []);
	});

	it("the environments, files and terminals plugins: the old objects are collected after a reload (guide 8.6)", async () => {
		const t = await topology(context);
		running = t;
		const [pi, files, terminals, machine, ann] = await t.server.root(async (ctx) => {
			const things = await ctx.get(ThingsStore, {});
			const one = async (kind: string) => await seeded(await ctx.get(OneThing, { kind }), ctx);
			const root = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
			const by = { kind: "plugin", plugin: "test" } as const;
			const person = await things.createPerson({ name: "Ann", madeBy: by }, ctx);
			await things.putParty({ workspace: root, party: { kind: "person", person }, source: by }, ctx);
			return [root, await one(FilesKind.name), await one(TerminalsKind.name), await one(MACHINE_KIND), person];
		}, context);
		const person = await t.client({ kind: "person", id: ann, name: "Ann" });
		const browser = await person.get(Files, { workspace: pi, thing: files }, context);
		const panes = await person.get(Terminals, { workspace: pi, thing: terminals }, context);
		const held = await person.get(Machine, { workspace: pi, thing: machine }, context);
		// The markers: what each plugin's objects made (the terminal host, the machines' resolver, the routes), read
		// through one registry value each, read again after the reloads (a value read once keeps its composition).
		const registries = {
			terminals: await t.server.registry(TerminalHosts, context),
			machines: await t.server.registry(MachineHosts, context),
			http: await t.server.registry(Http, context),
		};
		const marked = () => [
			new WeakRef(registries.terminals.value!),
			new WeakRef(registries.machines.value),
			...routes(registries.http.value).map((route) => new WeakRef(route)),
		];
		const before = marked();
		for (const plugin of ["environments", "files", "terminals"]) await t.reload(`@earendil-works/p3-${plugin}`);
		await until(browser.state, (state) => state.kind === "live", within("Files again", context));
		await until(panes.state, (state) => state.kind === "live", within("Terminals again", context));
		await until(held.state, (state) => state.kind === "live", within("the machine again", context));
		await browser.entries!({ machine, path: tmpdir() }, context);
		assert.equal(held.info.value.status, "ready");
		const after = marked();
		assert.ok(
			before.every((ref, i) => ref.deref() !== after[i]!.deref()),
			"new objects",
		);
		assert.ok(await collected(before), "the old objects of the three plugins are collected");
		assert.deepEqual(t.errors, []);
	});

	it("the people, apps and environments plugins: a person's objects and the owner's go on", async () => {
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
		const machine = (await owner.get(ThisDevice, {}, context)).machine.value;
		const coding = (apps: readonly { readonly id: string }[]) => apps.some(({ id: app }) => app === "coding");
		await until(catalog.apps, coding, within("her catalog", context));
		for (const plugin of ["people", "apps", "environments", "sessions"])
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
			[machine],
		);
		assert.deepEqual(t.errors, []);
	});

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
		// The list's page and session A's two reads (its worker's row and its route's); B's run not, and ask nothing.
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [3, 0]);
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
		// As a rename: the list's page and session A's two reads (its worker's row and its route's); B's not.
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [3, 0]);
		assert.equal(list.list.value.rows.find(({ id }) => id === a)?.state, "working");
	});

	// The route's admission and the worker's `admitSession` share one standing (the owner's person's: the session's row,
	// the person's row, their groups and the session's members); the worker's facts read what the session has (its
	// row, its links, its members, the followed person's row and groups, and their things "in all my sessions") and
	// its things' default and the agent's options.
	it("a hold of a session's worker costs twelve reads: the owner's standing and its worker's facts; a second hold none", async () => {
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
			[12, 0, 0, 0],
		);
	});
});
