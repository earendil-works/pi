// The topology tier (`test/topology.ts`): reloads of the plugins the skeleton touches while they are in use, access
// (every object refuses the principals it does not serve), and the work a common action costs.

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import { isChordError } from "@earendil-works/chord";
import {
	BACKGROUND_CONTEXT as context,
	Environments,
	Me,
	type P3Principal,
	SessionFacts,
	SessionObject,
	SessionWorker,
	ThisDevice,
	until,
	Workspace,
	WorkspaceChildren,
	withGranted,
} from "@earendil-works/p3/v1";
import {
	Http,
	PeopleStore,
	type Router,
	ServerCommands,
	SessionsStore,
	ThingsStore,
} from "@earendil-works/p3/v1/server";
import { MachineHosts } from "../plugins/environments/contract.server.ts";
import { TerminalHosts } from "../plugins/environments/contract.terminal-host.server.ts";
import { MACHINE_KIND } from "../plugins/environments/contract.ts";
import { Machine } from "../plugins/environments/kind.ts";
import { seeded } from "../plugins/environments/test/seeded.ts";
import { DOWNLOAD_PATH, Files, FilesKind, UPLOAD_PATH } from "../plugins/files/kind.ts";
import { SessionStart } from "../plugins/sessions/contract.ts";
import { SignIns } from "../plugins/sign-in/contract.ts";
import { ATTACH_PATH, Terminals, TerminalsKind } from "../plugins/terminals/kind.ts";
import { OneThing } from "../plugins/things/contract.server.ts";
import { Probe } from "./plugins/probe/contract.ts";
import { newSession, piOf } from "./support.ts";
import { type Topology, topology } from "./topology.ts";
import { collected, eventually, within } from "./until.ts";

const PERSON: P3Principal = { kind: "person", id: "p1", name: "Ann" };

let running: Topology | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/**
 * A topology with one session and an owner client: the session's id, Pi's, `make` (a new session titled `title`),
 * `archive` (a session, with the owner's Manage of it) and `rename` (with the owner's Configure in Pi).
 */
async function withSession(idleMs?: number) {
	const t = await topology(context, idleMs);
	running = t;
	const owner = await t.client(t.owner);
	// Where the topology's sessions work: this device's machine, in /tmp.
	const here = { environment: (await owner.get(ThisDevice, {}, context)).machine.value, folder: "/tmp" };
	const make = (title: string) => newSession(owner, title, context, here);
	const archive = async (session: string) => {
		const held = await owner.get(SessionObject, { workspace: session, thing: session }, context);
		await withGranted(held, "archive")!.archive(context);
	};
	const pi = await piOf(owner, context);
	const rename = async (session: string, name: string) => {
		const workspace = await owner.get(Workspace, { workspace: pi }, context);
		await withGranted(workspace, "configure")!.configure({ thing: session, name }, context);
	};
	const id = await make("one");
	return { t, owner, make, archive, rename, id, pi };
}

/**
 * Until the things store has adopted the people plugin's owner as its owner: a reload of things while the first
 * start's adoption still commits cancels it (a one-time window at a Pi's first start).
 */
async function ownerAdopted(t: Topology): Promise<void> {
	const id = t.owner.kind === "person" ? t.owner.id : "";
	const owners = () =>
		t.server.root(
			async (ctx) => (await (await ctx.get(ThingsStore, {})).persons.owners.page({}, 10, ctx)).items,
			context,
		);
	await eventually(owners, (items) => items.some(({ person }) => person === id));
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
	it("the sessions plugin on the server: a session's object and a worker's row go on, a new session is listed", async () => {
		const { t, owner, make, archive, id, pi } = await withSession();
		const list = await owner.get(WorkspaceChildren, { workspace: pi, view: "v1" }, context);
		const session = await owner.get(SessionObject, { workspace: id, thing: id }, context);
		const worker = await owner.get(SessionWorker, { session: id }, context);
		assert.equal(worker.state.value.kind, "live");
		await t.reload("@earendil-works/p3-sessions");
		const second = await make("two");
		await until(
			list.list,
			(value) => value.rows.some((row) => row.workspace === second),
			within("the second row", context),
		);
		await archive(id);
		await until(worker.session, (row) => row?.archivedAt !== null, within("the archived row", context));
		await until(session.row, (row) => row.archivedAt !== null, within("the archived object", context));
		assert.deepEqual(t.errors, []);
	});

	it("the sessions plugin on a worker: its row still follows the server", async () => {
		const { t, owner, archive, id } = await withSession();
		const worker = await owner.get(SessionWorker, { session: id }, context);
		await t.reload("@earendil-works/p3-sessions", id);
		await archive(id);
		await until(worker.session, (row) => row?.archivedAt !== null, within("the archived row", context));
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

	it("the people, environments, things and sessions plugins: a person's objects and the owner's go on", async () => {
		const { t, owner, id, pi } = await withSession();
		await ownerAdopted(t);
		const ann = await t.server.root(
			async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name: "Ann" }, ctx),
			context,
		);
		// Ann is put into Pi: the session's grant for everyone here (Read, Send) is hers.
		await t.server.root(async (ctx) => {
			const things = await ctx.get(ThingsStore, {});
			const party = { kind: "person", person: ann } as const;
			await things.putParty({ workspace: pi, party, source: { kind: "plugin", plugin: "test" } }, ctx);
		}, context);
		const person = await t.client({ kind: "person", id: ann, name: "Ann" });
		const me = await person.get(Me, {}, context);
		const session = await person.get(SessionObject, { workspace: id, thing: id }, context);
		const environments = await owner.get(Environments, {}, context);
		for (const plugin of ["people", "environments", "things", "sessions"])
			await t.reload(`@earendil-works/p3-${plugin}`);
		await t.server.root(
			async (ctx) => (await ctx.get(PeopleStore, {})).renamePerson({ person: ann, name: "Anna" }, ctx),
			context,
		);
		await until(me.me, (value) => value.kind === "person" && value.name === "Anna", within("the new name", context));
		await until(session.state, (state) => state.kind === "live", within("her session", context));
		assert.equal(session.row.value.id, id);
		assert.deepEqual(
			environments.environments.value.map(({ id: environment }) => environment),
			[(await owner.get(ThisDevice, {}, context)).machine.value],
		);
		assert.deepEqual(t.errors, []);
	});

	const orders: readonly { readonly order: readonly string[]; readonly todo?: string }[] = [
		{ order: ["people", "sign-in", "things"] },
		{ order: ["people", "environments", "things", "sessions"] },
		// Back to back: a things store started anew (lazily, by whichever plugin uses it first) is reloaded again.
		{
			order: ["people", "environments", "things", "people", "environments", "things", "sessions"],
			todo: "transaction_cancelled on a things reload during seedKind: ERNDL-1190",
		},
		{ order: ["people", "sign-in", "things", "people", "environments", "things", "sessions"] },
		{ order: ["people", "sign-in", "things", "people", "sign-in", "things"] },
	];
	for (const { order, todo } of orders) {
		const name = `the ${order.join(", ")} plugins reloaded in that order (the owner bridge, ERNDL-1144): nothing reported`;
		it(name, { todo }, async () => {
			const { t, owner } = await withSession();
			const me = await owner.get(Me, {}, context);
			await ownerAdopted(t);
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
	it("a person not in Pi reaches nothing of it, nor of a session there", async () => {
		const { t, id, pi } = await withSession();
		const person = await t.client(PERSON);
		await refused(person.get(Workspace, { workspace: pi }, context, { readyTimeout: 1000 }), "forbidden");
		await refused(
			person.get(SessionObject, { workspace: id, thing: id }, context, { readyTimeout: 1000 }),
			"forbidden",
		);
		await refused(person.get(SessionWorker, { session: id }, context, { readyTimeout: 1000 }), "forbidden");
		await refused(person.get(Probe, { session: id }, context, { readyTimeout: 1000 }), "forbidden");
		assert.equal(t.workers.has(id), false, "no worker started for a person outside the session");
	});

	it("the owner reaches neither a worker's nor the waker's objects", async () => {
		const { owner, id } = await withSession();
		await refused(owner.get(SessionFacts, {}, context), "forbidden");
		await refused(owner.get(SessionStart, { session: id }, context), "forbidden");
	});

	// Astra, round 1 (must 3): a plain workspace answers on itself too, but has no worker.
	it("no worker starts for a plain workspace", async () => {
		const { t, owner, pi } = await withSession();
		await refused(owner.get(SessionWorker, { session: pi }, context, { readyTimeout: 1000 }), "forbidden");
		assert.equal(t.workers.has(pi), false);
	});

	// ERNDL-704 test 6 (Opus, round 1).
	it("listing a workspace's sessions starts no worker", async () => {
		const { t, owner, make, id, pi } = await withSession();
		const other = await make("two");
		const list = await owner.get(WorkspaceChildren, { workspace: pi, view: "v" }, context);
		await until(list.list, (value) => value.rows.some((row) => row.workspace === other), within("the list", context));
		assert.equal(t.workers.has(id) || t.workers.has(other), false);
	});

	it("no worker starts for a session that does not exist", async () => {
		const { t, owner } = await withSession();
		await assert.rejects(owner.get(SessionWorker, { session: "none" }, context, { readyTimeout: 1000 }));
		assert.equal(t.workers.has("none"), false);
	});

	it("a session's worker reaches its own row, never another session's worker", async () => {
		const { t, make, id } = await withSession();
		const other = await make("other");
		const worker = await t.client({ kind: "worker", session: id });
		const facts = await worker.get(SessionFacts, {}, context);
		assert.equal(facts.session.value?.id, id);
		await assert.rejects(worker.get(SessionWorker, { session: other }, context, { readyTimeout: 1000 }));
		assert.equal(t.workers.has(other), false, "no worker started for a refused principal");
	});
});

describe("counted work", () => {
	it("a rename runs only the things plugin's reads of the renamed session", async () => {
		const { t, owner, make, rename, id: a, pi } = await withSession();
		const b = await make("B");
		await owner.get(WorkspaceChildren, { workspace: pi, view: "v" }, context);
		const workerB = await owner.get(SessionWorker, { session: b }, context);
		await owner.get(SessionWorker, { session: a }, context);
		const before = [t.count("chord.query.runs"), t.count("chord.query.probes")];
		await rename(a, "A2");
		// A session's name is its thing's (Configure in its parent): the things plugin's reads of the renamed thing and
		// its line, the children list's page among them; no row of the sessions plugin and nothing of B's, and nothing
		// is asked (the index answers the admissions).
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [3, 0]);
		assert.equal(workerB.session.value?.id, b);
	});

	it("a worker's report runs only the reads that show its session", async () => {
		const { t, owner, make, id: a, pi } = await withSession();
		const b = await make("B");
		await owner.get(WorkspaceChildren, { workspace: pi, view: "v" }, context);
		await owner.get(SessionWorker, { session: b }, context);
		const session = await owner.get(SessionObject, { workspace: a, thing: a }, context);
		const probe = await owner.get(Probe, { session: a }, context);
		const before = [t.count("chord.query.runs"), t.count("chord.query.probes")];
		await probe.report({ state: "working" }, context);
		// A's session row only, shared by its worker's facts and the owner's object; the children list reads no state.
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [1, 0]);
		await until(session.row, (row) => row.state === "working", within("the report", context));
	});

	// The route's admission and the worker objects' (`followSession`) read the access index, no query; the worker's
	// facts read its session's row: one run; a second hold shares it.
	it("a hold of a session's worker costs one read: its worker's row; a second hold none", async () => {
		const { t, owner, id, pi } = await withSession();
		await owner.get(WorkspaceChildren, { workspace: pi, view: "v" }, context);
		const counted = () => [t.count("chord.query.runs"), t.count("chord.query.probes")];
		const first = counted();
		await owner.get(SessionWorker, { session: id }, context);
		const second = counted();
		await (await t.client(t.owner)).get(SessionWorker, { session: id }, context);
		const after = counted();
		assert.deepEqual(
			[second[0]! - first[0]!, second[1]! - first[1]!, after[0]! - second[0]!, after[1]! - second[1]!],
			[1, 0, 0, 0],
		);
	});
});
