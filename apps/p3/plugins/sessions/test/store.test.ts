// The sessions store (`store.ts`) as server code calls it: a row written by the session kind's create hook (this
// device in a folder of its own, or a location on a machine there is), its writes refused for a session there is
// not, an archived session's report of working refused, the waker's `working` without archived sessions, and a model
// choice of version 1 read as none (in a session's row and in session defaults).

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, defineFacet, type Reference, THIS_DEVICE } from "@earendil-works/p3/v1";
import { type ServerRuntime, ServerRuntime as ServerRuntimeRegistry } from "@earendil-works/p3/v1/server";
import environmentsServer from "../../environments/server.ts";
import { type World, world } from "../../things/test/world.ts";
import { SessionsStore } from "../contract.server.ts";
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

	it("reads a stored model choice of version 1 (a provider, not a login) as none (decision 125)", async () => {
		await store.insert({ id: "s1", model: { login: "l1", model: "m", thinking: "high" } }, context);
		// The cell as version 1 wrote it, through a connection of its own (the row key as the file has it).
		const file = new DatabaseSync(w.path, { timeout: 5000 });
		file
			.prepare('UPDATE "sessions.store:sessions.sessions" SET "model" = ?, "model$v" = 1 WHERE "id" = ?')
			.run(JSON.stringify({ provider: "anthropic", model: "m", thinking: "high" }), "session|s1");
		file.close();
		assert.equal((await row("s1"))?.model, null);
	});

	it("reads session defaults of version 1 with everything but their model (decision 125)", async () => {
		const settings = await w.host.get(DefaultsSettings, {}, context);
		const kept = { shared: false, opensWith: "transcript.session" };
		// A row as version 1 wrote it, through a connection of its own.
		const file = new DatabaseSync(w.path, { timeout: 5000 });
		file
			.prepare(
				'INSERT INTO "sessions.defaults-settings:sessions.settings" ("thing", "defaults", "defaults$v", "$v") VALUES (?, ?, 1, 1)',
			)
			.run("d1", JSON.stringify({ ...kept, model: { provider: "anthropic", model: "m", thinking: "high" } }));
		file.close();
		const [read] = (await settings.settings.of.page({ thing: "d1" }, 1, context)).items;
		assert.deepEqual(read?.defaults, { ...kept, model: null });
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
