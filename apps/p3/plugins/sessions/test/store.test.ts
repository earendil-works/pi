// The sessions store (`store.ts`) as server code calls it: a row written by the session kind's create hook (this
// device's machine in a folder of its own under the work root, or a location on a machine there is), its writes refused for a session there is
// not, an archived session's report of working refused, and the waker's `working` without archived sessions.

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	defineFacet,
	defineTable,
	host as hostColumn,
	int,
	json,
	local,
	method,
	nul,
	obj,
	type Reference,
	Session,
	str,
	union,
} from "@earendil-works/p3/v1";
import { type ServerRuntime, ServerRuntime as ServerRuntimeRegistry } from "@earendil-works/p3/v1/server";
import { eventually } from "../../../test/until.ts";
import { MachineHosts } from "../../environments/contract.server.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { OneThing } from "../../things/contract.server.ts";
import { type World, world } from "../../things/test/world.ts";
import { SessionsStore } from "../contract.server.ts";
import { ModelChoice } from "../contract.ts";
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
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		await store.insert({ id: "s1", model: null }, context);
		const own = await row("s1");
		assert.deepEqual(own?.location, { environment: machine, folder: join(dataDir, "work", "s1") });
		assert.ok((await stat(own!.location.folder)).isDirectory());
		assert.deepEqual([own?.state, own?.archivedAt, own?.model], ["settled", null, null]);
		await store.insert({ id: "s2", location: { environment: machine, folder: "/tmp" }, model: null }, context);
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

describe("a Pi's rows from before the machine was a thing (decision 125)", () => {
	/** The sessions table as 7093618af wrote it (version 1): a copy, as data older code left. */
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
			model: json(union([ModelChoice, nul()]), { version: 1 }),
		},
		key: ["id"],
		indexes: { working: ["state", "archivedAt"] },
	});

	/** The sessions store as older code served it, enough to write one row: the same owner, its table. */
	const OldStore = local("sessions.store", {
		version: 1,
		params: {},
		members: { put: method(obj({ id: str(), environment: str(), folder: str() })) },
	});

	const older = defineFacet((host) =>
		host.serve(OldStore, (_params, self) => {
			const rows = self.table(OldRows);
			return {
				put: ({ id, environment, folder }, ctx) =>
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
							model: null,
						});
						return null;
					}, ctx),
			};
		}),
	);

	it("names this device's machine once the store starts, and a session works there (Files opens it)", async () => {
		await w.close(context);
		const runtime = {
			dataDir,
			workRoot: join(dataDir, "work"),
			machine: { user: "test", hostname: "test" },
		} as ServerRuntime;
		w = await world(context, [
			{
				name: "p3.server",
				facet: defineFacet((host) => host.serve(ServerRuntimeRegistry, { compose: () => runtime })),
			},
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
			{ name: "@earendil-works/p3-sessions", facet: older },
		]);
		await (await w.host.get(OldStore, {}, context)).put(
			{ id: "old", environment: "this-device", folder: dataDir },
			context,
		);
		// The update: the sessions plugin's code as it is now, on the same store.
		await w.reload("@earendil-works/p3-sessions", context, sessionsServer);
		store = await w.host.get(SessionsStore, {}, context);
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		await eventually(
			async () => (await row("old"))?.location.environment,
			(environment) => environment === machine,
		);
		assert.equal((await row("old"))?.location.folder, dataDir);
		// The machine's host is reached for it, as Files and the harness reach it.
		const hosts = (await w.host.registry(MachineHosts, context)).value;
		assert.ok((await hosts(machine, context)) !== undefined);
	});
});
