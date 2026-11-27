// The sessions store (`store.ts`) as server code calls it: a row written by the session kind's create hook (this
// device in a folder of its own, or a location on a machine there is), its writes refused for a session there is
// not, an archived session's report of working refused, the waker's `working` without archived sessions; and a store
// version 1 wrote (7093618af) opened by this version: a session's model choice reads as none, session defaults keep
// everything but their model.

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
	type P3Principal,
	type Reference,
	Server,
	Session,
	sqliteBackend,
	str,
	THIS_DEVICE,
	union,
} from "@earendil-works/p3/v1";
import { type ServerRuntime, ServerRuntime as ServerRuntimeRegistry } from "@earendil-works/p3/v1/server";
import environmentsServer from "../../environments/server.ts";
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
	const runtime = { dataDir, machine: { user: "test", hostname: "test" } } as ServerRuntime;
	w = await world(context, [
		{
			name: "p3.server",
			facet: defineFacet((host) => host.serve(ServerRuntimeRegistry, { compose: () => runtime })),
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
		await store.insert({ id: "s1", model: null }, context);
		const own = await row("s1");
		assert.deepEqual(own?.location, { environment: THIS_DEVICE, folder: join(dataDir, "folders", "s1") });
		assert.ok((await stat(own!.location.folder)).isDirectory());
		assert.deepEqual([own?.state, own?.archivedAt, own?.model], ["settled", null, null]);
		await store.insert({ id: "s2", location: { environment: THIS_DEVICE, folder: "/tmp" }, model: null }, context);
		assert.equal((await row("s2"))?.location.folder, "/tmp");
		await assert.rejects(
			store.insert({ id: "s3", location: { environment: "nowhere", folder: "/tmp" }, model: null }, context),
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

/** Their owners, by name (a table's stored name is its owner's and its own), each writing one row. */
const OldStore = local("sessions.store", { version: 1, params: {}, members: { write: method(obj({})) } });
const OldDefaults = local("sessions.defaults-settings", {
	version: 1,
	params: {},
	members: { write: method(obj({})) },
});

/** The faux model choice version 1 stored. */
const OLD_CHOICE = { provider: "anthropic", model: "claude", thinking: "high" } as const;

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
		await host.load(
			[
				{
					name: "@earendil-works/p3-sessions",
					facet: defineFacet((facetHost) => {
						facetHost.serve(OldStore, (_params, self) => {
							const rows = self.table(OldRows);
							return {
								write: (_args, ctx) =>
									self.tx(async (tx) => {
										tx.put(rows, {
											id: Session({ id: "s1" }),
											environment: THIS_DEVICE,
											folder: "/tmp",
											createdAt: 1,
											state: "settled",
											lastTouch: 1,
											archivedAt: 0,
											model: OLD_CHOICE,
										});
										return null;
									}, ctx),
							};
						});
						facetHost.serve(OldDefaults, (_params, self) => {
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
					}),
				},
			],
			context,
		);
		await (await host.get(OldStore, {}, context)).write({}, context);
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
	const runtime = { dataDir, machine: { user: "test", hostname: "test" } } as ServerRuntime;
	const now = await world(
		context,
		[
			{
				name: "p3.server",
				facet: defineFacet((facetHost) => facetHost.serve(ServerRuntimeRegistry, { compose: () => runtime })),
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
