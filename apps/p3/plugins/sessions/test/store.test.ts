// The sessions store (`store.ts`) as server code calls it: a row written by the session kind's create hook (this
// device's machine in a folder of its own under the work root, or a location on a machine there is), its writes
// refused for a session there is not, an archived session's report of working refused, the waker's `working` without
// archived sessions, and a store of p3-base's first version (the machine column named `environment`) opened by this
// one: its rows keep where they work.

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	defineTable,
	type HostError,
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
import { type ServerRuntime, ServerRuntime as ServerRuntimeRegistry } from "@earendil-works/p3/v1/server";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { OneThing } from "../../things/contract.server.ts";
import { THINGS, type World, world } from "../../things/test/world.ts";
import { SessionsStore } from "../contract.server.ts";
import { ModelChoice } from "../contract.ts";
import sessionsServer from "../server.ts";

let w: World;
let store: Reference<typeof SessionsStore>;
let dataDir: string;

/** The base's runtime, the environments plugin and the sessions plugin, as the server loads them, over `dataDir`. */
function plugins(dataDir: string): PluginFacet<P3Principal>[] {
	const runtime = {
		dataDir,
		workRoot: join(dataDir, "work"),
		machine: { user: "test", hostname: "test" },
	} as ServerRuntime;
	return [
		{
			name: "p3.server",
			facet: defineFacet((host) => host.serve(ServerRuntimeRegistry, { compose: () => runtime })),
		},
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
		{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
	];
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "p3-sessions-store-"));
	w = await world(context, plugins(dataDir));
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
		assert.equal((await row("s2"))?.location.folder, "/tmp");
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

/** The rows table as p3-base's first version stored it (its machine column named `environment`). */
const RowsV1 = defineTable("sessions.sessions", {
	version: 1,
	columns: {
		id: hostColumn(Session),
		environment: str(),
		folder: str(),
		createdAt: int(),
		state: str(),
		lastTouch: int(),
		archivedAt: int(),
		model: json(union([ModelChoice, nul()]), { version: 1 }),
	},
	key: ["id"],
	indexes: { working: ["state", "archivedAt"] },
});

/** The store object of that version, by its name (a table belongs to its object's contract): it writes one row. */
const StoreV1 = local("sessions.store", {
	version: 1,
	params: {},
	members: { put: method(obj({ id: str(), environment: str(), folder: str() })) },
});

/** A host on the store at `path` with `facets` loaded; closed with its store by `close`. */
async function hostAt(path: string, facets: readonly PluginFacet<P3Principal>[]) {
	const db = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const errors: HostError[] = [];
	const host = createHost<P3Principal>({
		address: Server(),
		principal: { kind: "server" },
		store: db,
		readyTimeout: 5000,
		onError: (error) => errors.push(error),
	});
	const loaded = await host.load(facets, context);
	if (loaded.failed.length > 0) throw new Error("hostAt: plugins failed", { cause: loaded.failed[0]!.error });
	return {
		host,
		errors,
		close: async () => {
			await host.close(context);
			await db.close(context);
		},
	};
}

describe("the sessions store's versions", () => {
	it("opens a store of version 1: its rows keep where they work (`environment` is `machine` now)", async () => {
		const path = join(dataDir, "v1.sqlite");
		const v1 = defineFacet((host) => {
			host.serve(StoreV1, (_params, self) => {
				const rows = self.table(RowsV1);
				return {
					put: ({ id, environment, folder }, ctx) =>
						self.tx(async (tx) => {
							const row = { environment, folder, createdAt: 1, state: "settled", lastTouch: 1, archivedAt: 0 };
							tx.put(rows, { id: Session({ id }), ...row, model: null });
							return null;
						}, ctx),
				};
			});
		});
		const before = await hostAt(path, [{ name: "@earendil-works/p3-sessions", facet: v1 }]);
		await (await before.host.get(StoreV1, {}, context)).put(
			{ id: "old", environment: "m1", folder: "/srv" },
			context,
		);
		await before.close();
		const after = await hostAt(path, [THINGS, ...plugins(dataDir)]);
		try {
			const sessions = await after.host.get(SessionsStore, {}, context);
			const found = (await sessions.sessions.one.page({ id: "old" }, 1, context)).items[0];
			assert.deepEqual(found?.location, { machine: "m1", folder: "/srv" });
			assert.equal(found?.state, "settled");
			assert.deepEqual(after.errors, []);
		} finally {
			await after.close();
		}
	});
});
