// The sessions store (`store.ts`) as server code calls it: a row written by the session kind's create hook (this
// device's machine in a folder of its own under the work root, or a location on a machine there is), its writes refused
// for a session there is not, an archived session's report of working refused, the waker's `working` without archived
// sessions; and data version 1 wrote (7093618af) opened by this version (decision 125): a session's model choice reads
// as none, session defaults keep everything but their model, and rows naming this device as `this-device` are
// rewritten (this device's machine, a session's own folder moved to the work root by one rename). A two-version restart
// is not possible in-tree: a stand-in of the older plugin writes the old rows.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	bool,
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	defineTable,
	host as hostColumn,
	int,
	json,
	local,
	method,
	nul,
	obj,
	openStore,
	opt,
	type P3Principal,
	type Reference,
	Server,
	Session,
	sqliteBackend,
	str,
	union,
} from "@earendil-works/p3/v1";
import {
	type ServerRuntime,
	ServerRuntime as ServerRuntimeRegistry,
	WorkerRunners,
} from "@earendil-works/p3/v1/server";
import { eventually } from "../../../test/until.ts";
import { MachineHosts } from "../../environments/contract.server.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import { type World, world } from "../../things/test/world.ts";
import { SessionsStore } from "../contract.server.ts";
import { ThinkingLevel } from "../contract.ts";
import { DefaultsSettings } from "../defaults.ts";
import sessionsServer from "../server.ts";

let w: World;
let store: Reference<typeof SessionsStore>;
let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "p3-sessions-store-"));
	const runtime = {
		dataDir,
		workRoot: join(dataDir, "work"),
		machine: { user: "test", hostname: "test" },
	} as ServerRuntime;
	w = await world(context, [
		{
			name: "p3.server",
			facet: defineFacet((host) => {
				host.serve(ServerRuntimeRegistry, { compose: () => runtime });
				// No runner: the plugin tier starts no worker, and a removal deletes no worker's data.
				host.serve(WorkerRunners, { compose: () => undefined });
			}),
		},
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
		{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
	]);
	store = await w.host.get(SessionsStore, {}, context);
});

afterEach(async () => {
	await w.close(context);
	await rm(dataDir, { recursive: true, force: true });
});

/** Session `id`'s row now. */
const row = async (id: string) => (await store.sessions.one.page({ id }, 1, context)).items[0];

describe("the sessions store", () => {
	it("writes a new row: this device in a folder it makes, or a given location on a machine there is", async () => {
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		await store.insert({ id: "s1", model: null }, context);
		const own = await row("s1");
		const things = await w.host.get(ThingsStore, {}, context);
		const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		assert.deepEqual(own?.location, { machine, folder: join(dataDir, "work", pi, "s1") });
		assert.ok((await stat(own!.location!.folder)).isDirectory());
		assert.deepEqual([own?.state, own?.archivedAt, own?.model], ["settled", null, null]);
		await store.insert({ id: "s2", location: { machine, folder: "/tmp" }, model: null }, context);
		assert.equal((await row("s2"))?.location?.folder, "/tmp");
		await assert.rejects(
			store.insert({ id: "s3", location: { machine: "nowhere", folder: "/tmp" }, model: null }, context),
			/no machine nowhere/,
		);
	});

	it("refuses every write for a session there is not", async () => {
		for (const write of [
			() => store.archive({ session: "none" }, context),
			() => store.restore({ session: "none" }, context),
			() => store.setModel({ session: "none", model: null }, context),
			() => store.report({ session: "none", state: "settled" }, context),
		]) {
			await assert.rejects(write(), /no session none/);
		}
	});

	it("leaves archived sessions out of `working`, and refuses an archived session's report of working", async () => {
		for (const id of ["a", "b"]) {
			await store.insert({ id, model: null }, context);
			await store.report({ session: id, state: "working" }, context);
		}
		await store.archive({ session: "b" }, context);
		assert.deepEqual(await store.working({}, context), ["a"]);
		await assert.rejects(store.report({ session: "b", state: "working" }, context), /is archived/);
		await store.report({ session: "b", state: "settled" }, context);
		await store.restore({ session: "b" }, context);
		await store.report({ session: "b", state: "working" }, context);
		assert.deepEqual((await store.working({}, context)).sort(), ["a", "b"]);
		await store.remove({ session: "a" }, context);
		assert.equal(await row("a"), undefined);
	});
});

/** A model choice as version 1 stored it: a provider, not a login. */
const OldChoice = obj({ provider: str({ max: 200 }), model: str({ max: 200 }), thinking: ThinkingLevel });

/** The sessions plugin's two tables as version 1 defined them (7093618af), copied: what Pis stored before 124. */
const OldRows = defineTable("sessions.sessions", {
	version: 1,
	columns: {
		id: hostColumn(Session),
		environment: str(),
		folder: str(),
		createdAt: int(),
		state: str(),
		lastTouch: int(),
		archivedAt: int(),
		model: json(union([OldChoice, nul()]), { version: 1 }),
	},
	key: ["id"],
	indexes: { working: ["state", "archivedAt"] },
});
const OldSettings = defineTable("sessions.settings", {
	version: 1,
	columns: {
		thing: str(),
		defaults: json(
			obj({ model: union([OldChoice, nul()]), shared: bool(), opensWith: union([str({ max: 200 }), nul()]) }),
			{ version: 1 },
		),
	},
	key: ["thing"],
});

/** Their owners, by name (a table's stored name is its owner's and its own): a session's row, a defaults' settings. */
const OldStore = local("sessions.store", {
	version: 1,
	params: {},
	members: { put: method(obj({ id: str(), environment: str(), folder: str(), model: opt(OldChoice) })) },
});
const OldDefaults = local("sessions.defaults-settings", {
	version: 1,
	params: {},
	members: { write: method(obj({})) },
});

/** The faux model choice version 1 stored. */
const OLD_CHOICE = { provider: "anthropic", model: "claude", thinking: "high" } as const;

/** The sessions plugin as version 1 served it, enough to write its rows: the same owners, their tables. */
const older = defineFacet((host) => {
	host.serve(OldStore, (_params, self) => {
		const rows = self.table(OldRows);
		return {
			put: ({ id, environment, folder, model }, ctx) =>
				self.tx(async (tx) => {
					const now = Date.now();
					tx.put(rows, {
						id: Session({ id }),
						environment,
						folder,
						createdAt: now,
						state: "settled",
						lastTouch: now,
						archivedAt: 0,
						model: model ?? null,
					});
					return null;
				}, ctx),
		};
	});
	host.serve(OldDefaults, (_params, self) => {
		const settings = self.table(OldSettings);
		return {
			write: (_args, ctx) =>
				self.tx(async (tx) => {
					tx.put(settings, {
						thing: "d1",
						defaults: { model: OLD_CHOICE, shared: false, opensWith: "transcript.session" },
					});
					return null;
				}, ctx),
		};
	});
});

describe("a Pi's rows from before the machine was a thing (decision 125)", () => {
	/**
	 * Restarts with the older store and work root `workRoot`, writes rows `rows` (`this-device`, each in its folder)
	 * through it, runs `prepare` with where this Pi's sessions get their own folders (`<workRoot>/<Pi's id>`), then
	 * updates to the sessions plugin as it is now, on the same store; this device's machine and that folder.
	 */
	async function updated(
		workRoot: string,
		rows: readonly { id: string; folder: string }[],
		prepare: (folders: string) => Promise<void> = async () => {},
	): Promise<{ machine: string; folders: string }> {
		await w.close(context);
		const runtime = { dataDir, workRoot, machine: { user: "test", hostname: "test" } } as ServerRuntime;
		w = await world(context, [
			{
				name: "p3.server",
				facet: defineFacet((host) => {
					host.serve(ServerRuntimeRegistry, { compose: () => runtime });
					// No runner: the plugin tier starts no worker, and a removal deletes no worker's data.
					host.serve(WorkerRunners, { compose: () => undefined });
				}),
			},
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
			{ name: "@earendil-works/p3-sessions", facet: older },
		]);
		const before = await w.host.get(OldStore, {}, context);
		for (const { id, folder } of rows) await before.put({ id, environment: "this-device", folder }, context);
		const things = await w.host.get(ThingsStore, {}, context);
		const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const folders = join(workRoot, pi);
		await prepare(folders);
		await w.reload("@earendil-works/p3-sessions", context, sessionsServer);
		store = await w.host.get(SessionsStore, {}, context);
		return { machine: await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context), folders };
	}

	/** Session `id`'s own folder as the older code made it. */
	const own = (id: string) => join(dataDir, "folders", id);

	// Astra, round 7: 00e4bc5e8 moved a folder to `<workRoot>/<id>` and could stop before writing its row; the row then
	// named a folder that was not there.
	it("points a row at the folder an earlier version moved it to, when only that one is there", async (t) => {
		const work = join(dataDir, "work");
		const earlier = join(work, "cut-before");
		const reported = t.mock.method(console, "error", () => {});
		const { machine } = await updated(work, [{ id: "cut-before", folder: own("cut-before") }], async () => {
			await mkdir(earlier, { recursive: true });
			await writeFile(join(earlier, "marker"), "existing");
		});
		await eventually(
			async () => (await row("cut-before"))?.location,
			(location) => location?.machine === machine && location.folder === earlier,
		);
		assert.equal(await readFile(join(earlier, "marker"), "utf8"), "existing");
		const said = reported.mock.calls.map((call) => String(call.arguments[0]));
		assert.deepEqual(
			said.filter((line) => line.includes("cut-before")),
			[],
		);
	});

	it("keeps a row's folder, and says so, when its folder is nowhere", async (t) => {
		const reported = t.mock.method(console, "error", () => {});
		const { machine } = await updated(join(dataDir, "work"), [{ id: "lost", folder: own("lost") }]);
		await eventually(
			async () => (await row("lost"))?.location,
			(location) => location?.machine === machine && location.folder === own("lost"),
		);
		const said = reported.mock.calls.map((call) => String(call.arguments[0]));
		assert.equal(said.filter((line) => line.includes(`${own("lost")} is not there`)).length, 1);
	});

	it("names this device's machine once the store starts, moves a session's own folder to this Pi's work folder, and a session works there (Files opens it)", async () => {
		// A session in its own folder, as the older code made it, with a file in it.
		await mkdir(own("own"), { recursive: true });
		await writeFile(join(own("own"), "marker"), "prior-content");
		await mkdir(own("taken"), { recursive: true });
		await writeFile(join(own("taken"), "marker"), "here");
		const rows = [
			// A location the person chose (not the session's own folder).
			{ id: "old", folder: dataDir },
			...["own", "cut", "taken"].map((id) => ({ id, folder: own(id) })),
		];
		const { machine, folders: work } = await updated(join(dataDir, "work"), rows, async (folders) => {
			// A move a crash cut short after the rename: the folder is at its new place only.
			await mkdir(join(folders, "cut"), { recursive: true });
			await writeFile(join(folders, "cut", "marker"), "moved");
			// The new place taken: nothing is overwritten, the files stay where they are.
			await mkdir(join(folders, "taken"), { recursive: true });
			await writeFile(join(folders, "taken", "other"), "there");
		});
		await eventually(
			// Version 1's `environment` is `machine` now (decision 24), and the rewrite runs on it.
			async () => (await row("old"))?.location?.machine,
			(found) => found === machine,
		);
		assert.equal((await row("old"))?.location?.folder, dataDir);
		await eventually(
			async () => (await row("own"))?.location,
			(location) => location?.machine === machine && location.folder === join(work, "own"),
		);
		assert.equal(await readFile(join(work, "own", "marker"), "utf8"), "prior-content");
		await assert.rejects(stat(own("own")), { code: "ENOENT" });
		assert.equal((await row("cut"))?.location?.folder, join(work, "cut"));
		assert.equal((await row("taken"))?.location?.folder, own("taken"));
		assert.equal(await readFile(join(own("taken"), "marker"), "utf8"), "here");
		assert.equal(await readFile(join(work, "taken", "other"), "utf8"), "there");
		// The machine's host is reached for it, as Files and the harness reach it.
		const hosts = (await w.host.registry(MachineHosts, context)).value;
		assert.ok((await hosts(machine, context)) !== undefined);
	});

	// Astra, round 6: a copy across file systems whose removal of the source failed halfway left the row on a source
	// with files missing. One rename only: where it cannot be done, the folder stays whole and the row keeps it.
	it("leaves a session's own folder whole where it is, the row on it, and says so, when the work root is on another file system", async (t) => {
		const work = await mkdtemp("/dev/shm/p3-sessions-work-").catch(() => undefined);
		if (work === undefined || (await stat(work)).dev === (await stat(dataDir)).dev) {
			t.skip("needs /dev/shm on another file system than the temporary directory");
			if (work !== undefined) await rm(work, { recursive: true, force: true });
			return;
		}
		const output = join(own("far"), "read-only-output");
		try {
			await mkdir(output, { recursive: true });
			await writeFile(join(output, "a"), "A");
			await writeFile(join(own("far"), "b"), "B");
			await chmod(output, 0o500);
			const reported = t.mock.method(console, "error", () => {});
			const { machine, folders } = await updated(work, [{ id: "far", folder: own("far") }]);
			await eventually(
				async () => (await row("far"))?.location,
				(location) => location?.machine === machine && location.folder === own("far"),
			);
			assert.deepEqual(
				[await readFile(join(own("far"), "b"), "utf8"), await readFile(join(output, "a"), "utf8")],
				["B", "A"],
			);
			await assert.rejects(stat(join(folders, "far")), { code: "ENOENT" });
			// Reported once, naming the folder that stays (deck2).
			const said = reported.mock.calls.map((call) => String(call.arguments[0]));
			assert.equal(said.filter((line) => line.includes(`${own("far")} stays where it is`)).length, 1);
		} finally {
			await chmod(output, 0o700).catch(() => undefined);
			await rm(work, { recursive: true, force: true });
		}
	});
});

describe("a store version 1 wrote (decision 125)", () => {
	it("opens: a model choice reads as none, defaults keep all but their model; a new choice outlives a restart", async () => {
		const path = join(dataDir, "old.sqlite");
		const old = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store: old,
			onError: (error) => assert.fail(error.kind),
		});
		await host.load([{ name: "@earendil-works/p3-sessions", facet: older }], context);
		await (await host.get(OldStore, {}, context)).put(
			{ id: "s1", environment: "this-device", folder: "/tmp", model: OLD_CHOICE },
			context,
		);
		await (await host.get(OldDefaults, {}, context)).write({}, context);
		await host.close(context);
		await old.close(context);
		const choice = { login: "l1", model: "m", thinking: "high" } as const;
		await opened(path, async (now) => {
			const sessions = await now.host.get(SessionsStore, {}, context);
			const [session] = (await sessions.sessions.one.page({ id: "s1" }, 1, context)).items;
			assert.deepEqual([session?.state, session?.model], ["settled", null]);
			const settings = await now.host.get(DefaultsSettings, {}, context);
			const [defaults] = (await settings.settings.of.page({ thing: "d1" }, 1, context)).items;
			assert.deepEqual(defaults?.defaults, {
				model: null,
				shared: false,
				opensWith: "transcript.session",
				location: null,
			});
			// A choice of this version, written now, is there after the next start (Astra, round 1 of model settings).
			await sessions.setModel({ session: "s1", model: choice }, context);
		});
		await opened(path, async (now) => {
			const sessions = await now.host.get(SessionsStore, {}, context);
			const [session] = (await sessions.sessions.one.page({ id: "s1" }, 1, context)).items;
			assert.deepEqual(session?.model, choice);
		});
	});
});

/** Runs `fn` on this version's sessions plugin over the store file at `path`, nothing reported, then closes it. */
async function opened(path: string, fn: (now: World) => Promise<void>): Promise<void> {
	const runtime = {
		dataDir,
		workRoot: join(dataDir, "work"),
		machine: { user: "test", hostname: "test" },
	} as ServerRuntime;
	const now = await world(
		context,
		[
			{
				name: "p3.server",
				facet: defineFacet((facetHost) => {
					facetHost.serve(ServerRuntimeRegistry, { compose: () => runtime });
					facetHost.serve(WorkerRunners, { compose: () => undefined });
				}),
			},
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
			{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
		],
		path,
	);
	try {
		await fn(now);
		assert.deepEqual(now.errors, []);
	} finally {
		await now.close(context);
	}
}
