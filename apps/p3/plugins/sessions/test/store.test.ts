// The sessions store (`store.ts`) as server code calls it: a row written by the session kind's create hook (this
// device's machine in a folder of its own under the work root, or a location on a machine there is), its writes refused
// for a session there is not, an archived session's report of working refused, the waker's `working` without archived
// sessions; and what version 1 wrote (7093618af) opened by this version (decision 125): rows naming this device by its
// old id name its machine, a session's own folder moved to the work root; a session's model choice reads as none,
// session defaults keep everything but their model (a two-version restart is not possible in-tree, so a stand-in of
// the older store writes them).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
	type Facet,
	host as hostColumn,
	int,
	json,
	local,
	method,
	nul,
	obj,
	openStore,
	type P3Principal,
	type PluginFacet,
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
import { OneThing } from "../../things/contract.server.ts";
import { type World, world } from "../../things/test/world.ts";
import { SessionsStore } from "../contract.server.ts";
import { ThinkingLevel } from "../contract.ts";
import { DefaultsSettings } from "../defaults.ts";
import sessionsServer from "../server.ts";

let w: World;
let store: Reference<typeof SessionsStore>;
let dataDir: string;

/** The base's runtime over `dataDir`, the environments plugin and `sessions` (the sessions plugin, or an older one). */
function plugins(sessions: Facet<P3Principal>): PluginFacet<P3Principal>[] {
	const runtime = {
		dataDir,
		workRoot: join(dataDir, "work"),
		machine: { user: "test", hostname: "test" },
	} as ServerRuntime;
	return [
		{
			name: "p3.server",
			facet: defineFacet((host) => {
				host.serve(ServerRuntimeRegistry, { compose: () => runtime });
				// No runner: the plugin tier starts no worker, and a removal deletes no worker's data.
				host.serve(WorkerRunners, { compose: () => undefined });
			}),
		},
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
		{ name: "@earendil-works/p3-sessions", facet: sessions },
	];
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "p3-sessions-store-"));
	w = await world(context, plugins(sessionsServer));
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
		assert.deepEqual(own?.location, { machine, folder: join(dataDir, "work", "s1") });
		assert.ok((await stat(own!.location.folder)).isDirectory());
		assert.deepEqual([own?.state, own?.archivedAt, own?.model], ["settled", null, null]);
		await store.insert({ id: "s2", location: { machine, folder: "/tmp" }, model: null }, context);
		assert.equal((await row("s2"))?.location?.folder, "/tmp");
		await assert.rejects(
			store.insert({ id: "s3", location: { machine: "nowhere", folder: "/tmp" }, model: null }, context),
			/no machine nowhere/,
		);
		// Fable, round 1: a relative folder was taken at the make and refused only at a move.
		await assert.rejects(
			store.insert({ id: "s4", location: { machine, folder: "tmp" }, model: null }, context),
			/no full path/,
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

/** Their owners, by name (a table's stored name is its owner's and its own), each writing one row. */
const OldStore = local("sessions.store", {
	version: 1,
	params: {},
	members: {
		put: method(obj({ id: str(), environment: str(), folder: str(), model: union([OldChoice, nul()]) })),
	},
});
const OldDefaults = local("sessions.defaults-settings", {
	version: 1,
	params: {},
	members: { write: method(obj({})) },
});

/** The sessions plugin as version 1 served it, enough to write its rows: the same owners, their tables. */
const older = defineFacet((host) => {
	host.serve(OldStore, (_params, self) => {
		const rows = self.table(OldRows);
		return {
			put: ({ id, environment, folder, model }, ctx) =>
				self.tx(async (tx) => {
					const now = Date.now();
					const row = { environment, folder, createdAt: now, state: "settled", lastTouch: now, archivedAt: 0 };
					tx.put(rows, { id: Session({ id }), ...row, model });
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

/** The faux model choice version 1 stored. */
const OLD_CHOICE = { provider: "anthropic", model: "claude", thinking: "high" } as const;

describe("a Pi's rows from before the machine was a thing (decision 125)", () => {
	it("names this device's machine once the store starts, moves a session's own folder to the work root, and a session works there (Files opens it)", async () => {
		await w.close(context);
		w = await world(context, plugins(older));
		const work = join(dataDir, "work");
		const own = (id: string) => join(dataDir, "folders", id);
		// A session in its own folder, as the older code made it, with a file in it.
		await mkdir(own("own"), { recursive: true });
		await writeFile(join(own("own"), "marker"), "prior-content");
		// A move a crash cut short after the rename: the folder is at its new place only.
		await mkdir(join(work, "cut"), { recursive: true });
		await writeFile(join(work, "cut", "marker"), "moved");
		// The new place taken: nothing is overwritten, the files stay where they are.
		await mkdir(own("taken"), { recursive: true });
		await writeFile(join(own("taken"), "marker"), "here");
		await mkdir(join(work, "taken"), { recursive: true });
		await writeFile(join(work, "taken", "other"), "there");
		const before = await w.host.get(OldStore, {}, context);
		// A location the person chose (not the session's own folder).
		await before.put({ id: "old", environment: "this-device", folder: dataDir, model: null }, context);
		for (const id of ["own", "cut", "taken"]) {
			await before.put({ id, environment: "this-device", folder: own(id), model: null }, context);
		}
		// The update: the sessions plugin's code as it is now, on the same store.
		await w.reload("@earendil-works/p3-sessions", context, sessionsServer);
		store = await w.host.get(SessionsStore, {}, context);
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		// Version 1's `environment` is version 2's `machine` (decision 24), and the rewrite runs on it.
		await eventually(
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
			assert.deepEqual(defaults?.defaults, { model: null, shared: false, opensWith: "transcript.session" });
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
	const now = await world(context, plugins(sessionsServer), path);
	try {
		await fn(now);
		assert.deepEqual(now.errors, []);
	} finally {
		await now.close(context);
	}
}
