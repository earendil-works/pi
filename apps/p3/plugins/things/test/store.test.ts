// The store's writes (`ThingsStore`): `create` runs the kind's `create` hook first, under the new id, then one commit
// (the thing, its link, the kind's default grants, every tick for its maker; item 34): a hook that throws leaves no
// thing, a commit that fails after the hook gets the kind's delete hook; a thing goes with its last link and its
// kind's `delete` hook runs, durably, until it succeeds; a kind of one workspace is linked once; Pi exists from the
// start; `deleteEverythingFrom` takes a source's rows and the groups it manages. What is on disk is read from the file.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	type Context,
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	openStore,
	type P3Principal,
	type Reference,
	Server,
	sqliteBackend,
	withCancel,
} from "@earendil-works/p3/v1";
import { eventually } from "../../../test/until.ts";
import { Gives, type ThingHook, ThingsStore } from "../contract.server.ts";
import type { Source } from "../contract.ts";
import { defineThing } from "../kind.ts";
import { serveThing } from "../serve.ts";
import { BOARD, BOARD_PLUGIN, Board, FAIL, HOOKS } from "./kinds.ts";
import { storedRows, THINGS, type World, world } from "./world.ts";

const BY: Source = { kind: "plugin", plugin: "test" };

let w: World;
let store: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	w = await world(context);
	store = await w.host.get(ThingsStore, {}, context);
	pi = (await store.workspaces.children.page({ parent: "" }, 10, context)).items[0]!.workspace;
	HOOKS.length = 0;
	FAIL.create = false;
});

afterEach(() => w.close(context));

/** The grants on disk of `thing` (in `workspace`, if given): party, source and ticks parsed. */
function grantsOf(thing: string, workspace?: string) {
	return w
		.rows("grants")
		.filter((row) => row.thing === thing && (workspace === undefined || row.workspace === workspace))
		.map((row) => ({
			workspace: String(row.workspace),
			party: JSON.parse(String(row.party)) as { kind: string },
			source: JSON.parse(String(row.source)) as Source,
			ticks: JSON.parse(String(row.ticks)) as string[],
			ticksVersion: Number(row.ticksVersion),
		}));
}

describe("the tree", () => {
	it("starts with Pi, the one root; a workspace is made under one that exists", async () => {
		const roots = (await store.workspaces.children.page({ parent: "" }, 10, context)).items;
		assert.deepEqual(
			roots.map(({ workspace }) => workspace),
			[pi],
		);
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const [row] = (await store.workspaces.one.page({ workspace: team }, 1, context)).items;
		assert.deepEqual(row, { workspace: team, parent: pi, showsThings: true, showsPeople: true });
		assert.deepEqual(
			(await store.workspaces.children.page({ parent: pi }, 10, context)).items.map(({ workspace }) => workspace),
			[team],
		);
		await assert.rejects(
			store.createWorkspace({ kind: "things.workspace", name: "x", parent: "nowhere", by: BY }, context),
			/no workspace nowhere/,
		);
		// After a reload of the plugin Pi is still the one root.
		await w.reload("@earendil-works/p3-things", context);
		const again = await w.host.get(ThingsStore, {}, context);
		assert.equal((await again.workspaces.children.page({ parent: "" }, 10, context)).items.length, 1);
	});
});

describe("making and deleting a thing", () => {
	it("create runs the kind's hook, then one commit: the thing, its link, the default grants and the maker's", async () => {
		const ada = await store.createPerson({ name: "Ada", madeBy: BY }, context);
		const by: Source = { kind: "person", person: ada };
		const thing = await store.create({ kind: Board.name, name: "Sketch", workspace: pi, by }, context);
		const [row] = (await store.things.one.page({ thing }, 1, context)).items;
		assert.deepEqual([row?.kind, row?.name, row?.madeBy], [Board.name, "Sketch", by]);
		assert.deepEqual((await store.links.here.page({ workspace: pi }, 10, context)).items, [
			{ workspace: pi, thing, of: Board.name },
		]);
		const grants = grantsOf(thing, pi);
		const summary = grants.map(({ party, source, ticks }) => [party.kind, source.kind, ticks]).sort();
		assert.deepEqual(summary, [
			["agents", "plugin", ["read"]],
			["everyone", "plugin", ["read"]],
			["person", "person", ["read", "write", "draw", "moderate", "look"]],
		]);
		assert.ok(grants.every(({ ticksVersion }) => ticksVersion === 1));
		assert.deepEqual(grants.find(({ party }) => party.kind === "everyone")?.source, {
			kind: "plugin",
			plugin: BOARD_PLUGIN,
		});
		assert.deepEqual(HOOKS, [`create ${thing}`]);
	});

	it("a create hook that throws leaves nothing: no thing, no link, no grant", async () => {
		FAIL.create = true;
		await assert.rejects(
			store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context),
			/could not be made/,
		);
		assert.equal(HOOKS.length, 1);
		assert.deepEqual(
			w.rows("things").filter(({ kind }) => kind === Board.name),
			[],
		);
		assert.deepEqual((await store.links.here.page({ workspace: pi }, 10, context)).items, []);
		assert.deepEqual((await store.grants.here.page({ workspace: pi }, 10, context)).items, []);
	});

	it("refuses a kind no plugin registers; a commit refused after the hook (no such workspace) runs the delete hook", async () => {
		await assert.rejects(
			store.create({ kind: "nobody.kind", name: "x", workspace: pi, by: BY }, context),
			/no kind nobody.kind/,
		);
		await assert.rejects(
			store.create({ kind: Board.name, name: "x", workspace: "nowhere", by: BY }, context),
			/no workspace/,
		);
		const thing = HOOKS[0]!.slice("create ".length);
		assert.deepEqual(HOOKS, [`create ${thing}`, `delete ${thing}`]);
		assert.deepEqual(
			w.rows("things").filter(({ kind }) => kind === Board.name),
			[],
		);
		assert.deepEqual(w.rows("pending"), []);
	});

	it("a thing goes with its last link: its grants and switches everywhere, then its kind's delete hook", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		await store.link({ workspace: team, thing, by: BY }, context);
		await store.setSwitch({ workspace: team, item: { kind: "thing", thing }, shown: false }, context);
		await store.unlink({ workspace: pi, thing }, context);
		assert.equal((await store.things.one.page({ thing }, 1, context)).items.length, 1);
		await store.unlink({ workspace: team, thing }, context);
		assert.deepEqual((await store.things.one.page({ thing }, 1, context)).items, []);
		assert.deepEqual(grantsOf(thing), []);
		assert.deepEqual((await store.switches.here.page({ workspace: team }, 10, context)).items, []);
		await eventually(
			() => HOOKS,
			(hooks) => hooks.includes(`delete ${thing}`),
		);
		await eventually(
			() => w.rows("pending").length,
			(count) => count === 0,
		);
	});
});

describe("a refused write", () => {
	it("leaves the disk as it was: of several grants refused for one, none is written", async () => {
		const ada = await store.createPerson({ name: "Ada", madeBy: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		const party = { kind: "person", person: ada } as const;
		const before = grantsOf(thing);
		await assert.rejects(
			store.setGrants(
				{
					source: BY,
					grants: [
						{ workspace: pi, thing, party, gives: true, ticks: ["read"], takenAway: [] },
						{ workspace: pi, thing, party: { kind: "everyone" }, gives: false, ticks: [], takenAway: [] },
						{ workspace: pi, thing, party, gives: true, ticks: ["fly"], takenAway: [] },
					],
				},
				context,
			),
			/has no tick fly/,
		);
		assert.deepEqual(grantsOf(thing), before);
	});
});

describe("linking", () => {
	it("a link starts with the kind's default grants; linking again changes nothing", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		await store.link({ workspace: team, thing, by: BY }, context);
		await store.link({ workspace: team, thing, by: BY }, context);
		assert.deepEqual(
			grantsOf(thing, team)
				.map(({ party }) => party.kind)
				.sort(),
			["agents", "everyone"],
		);
		await assert.rejects(store.link({ workspace: team, thing: "none", by: BY }, context), /no thing none/);
	});

	it("a kind of one workspace is linked in one only", async (t) => {
		const label = { namespace: "test", key: "use", params: [] };
		const Single = defineThing("test.single", { version: 1, workspaces: "one", ticks: { use: { label } } });
		const at = await world(context, [
			{ name: "single", facet: defineFacet((host) => serveThing(host, Single, { implement: () => ({}) })) },
		]);
		t.after(() => at.close(context));
		const things = await at.host.get(ThingsStore, {}, context);
		const root = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const team = await things.createWorkspace({ kind: "things.workspace", name: "T", parent: root, by: BY }, context);
		const thing = await things.create({ kind: Single.name, name: "s", workspace: root, by: BY }, context);
		// Linking it again where it is changes nothing; anywhere else is refused.
		await things.link({ workspace: root, thing, by: BY }, context);
		await assert.rejects(things.link({ workspace: team, thing, by: BY }, context), /linked in one workspace only/);
		assert.deepEqual(
			at.rows("links").map(({ workspace }) => workspace),
			[root],
		);
	});
});

describe("people", () => {
	it("only a person, a group or a session's agent is put in", async () => {
		await assert.rejects(
			store.putParty({ workspace: pi, party: { kind: "everyone" }, source: BY }, context),
			/no party one puts in/,
		);
	});

	it("deleteEverythingFrom takes a source's grants, memberships and entries, and the groups it manages with all naming them", async () => {
		const share: Source = { kind: "thing", thing: "share" };
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		const kim = await store.createPerson({ name: "Kim", madeBy: share }, context);
		const guests = await store.makeGroup(
			{ name: "guests", managedBy: { kind: "thing", thing: "share" }, outside: true },
			context,
		);
		const kept = await store.makeGroup({ name: "kept", managedBy: { kind: "people" }, outside: false }, context);
		await store.addToGroup({ group: guests, person: kim, source: BY }, context);
		await store.addToGroup({ group: kept, person: kim, source: share }, context);
		await store.addToGroup({ group: kept, person: kim, source: BY }, context);
		await store.putParty({ workspace: pi, party: { kind: "group", group: guests }, source: BY }, context);
		// A person wrote a grant for the share's group: it goes with the group.
		await store.setGrants(
			{
				source: BY,
				grants: [
					{
						workspace: pi,
						thing,
						party: { kind: "group", group: guests },
						gives: true,
						ticks: ["read"],
						takenAway: [],
					},
				],
			},
			context,
		);
		await store.deleteEverythingFrom({ source: share }, context);
		assert.deepEqual(
			w.rows("groups").map(({ group }) => group),
			[kept],
		);
		assert.deepEqual(
			(await store.groupMembers.ofPerson.page({ person: kim }, 10, context)).items.map(({ group, source }) => [
				group,
				source,
			]),
			[[kept, BY]],
		);
		assert.deepEqual((await store.workspaceMembers.here.page({ workspace: pi }, 10, context)).items, []);
		assert.deepEqual(
			grantsOf(thing).filter(({ party }) => party.kind === "group"),
			[],
		);
	});
});

describe("round 1's reproductions (Astra, Sol)", () => {
	const source: Source = { kind: "plugin", plugin: "fixture" };
	const label = { namespace: "test", key: "mark", params: [] };
	const Marker = defineThing("test.marker", { version: 1, ticks: { mark: { label } } });
	const marker = (hooks: Omit<ThingHook, "kind">) => ({
		name: "marker",
		facet: defineFacet((host) => serveThing(host, Marker, { implement: () => ({}), ...hooks })),
	});
	/** A world with the marker kind's plugin; its store and Pi. */
	const markerWorld = async (hooks: Omit<ThingHook, "kind">) => {
		const plugin = marker(hooks);
		const at = await world(context, [plugin]);
		const things = await at.host.get(ThingsStore, {}, context);
		const root = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		return { w: at, store: things, pi: root, plugin };
	};
	/** The marker things on disk at `path`. */
	const markers = (path: string) => storedRows(path, "things").filter(({ kind }) => kind === Marker.name);
	/** A copy of the committed file at `path`, as a crash would leave it. */
	const snapshot = (path: string, copy: string) => {
		const database = new DatabaseSync(path);
		database.prepare("VACUUM INTO ?").run(copy);
		database.close();
	};
	/** A host of its own on the store file at `path`, with the things plugin and `plugin`; `run` with its store. */
	const reopen = async (path: string, plugin: { name: string; facet: ReturnType<typeof defineFacet> }) => {
		const reopened = await openStore(sqliteBackend(new NodeSqliteDatabase(new DatabaseSync(path))), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store: reopened,
			onError: (error) => assert.fail(`host error ${error.kind}`),
		});
		await host.load([THINGS, plugin], context);
		return {
			store: await host.get(ThingsStore, {}, context),
			close: async () => {
				await host.close(context);
				await reopened.close(context);
			},
		};
	};

	it("Astra: two unlinks at once of a thing's two links remove it", async () => {
		const leaf = await store.createWorkspace({ parent: pi, name: "leaf", kind: "things.workspace", by: BY }, context);
		const thing = await store.create({ workspace: pi, kind: Board.name, name: "two", by: BY }, context);
		await store.link({ workspace: leaf, thing, by: BY }, context);
		await Promise.all([
			store.unlink({ workspace: pi, thing }, context),
			store.unlink({ workspace: leaf, thing }, context),
		]);
		assert.deepEqual((await store.things.one.page({ thing }, 1, context)).items, []);
	});

	for (const mode of ["throws at once", "rejects after its caller cancelled"] as const) {
		it(`Astra 3, Sol: a create hook that ${mode} leaves no thing`, async (t) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const create =
				mode === "throws at once"
					? (): Promise<void> => {
							throw new Error("bad input");
						}
					: async () => {
							entered.resolve();
							await release.promise;
							throw new Error("create failed");
						};
			const at = await markerWorld({ create });
			t.after(() => at.w.close(context));
			const cancelled = withCancel(context);
			const creating = assert.rejects(
				at.store.create({ kind: Marker.name, name: "failed", workspace: at.pi, by: source }, cancelled.context),
			);
			if (mode !== "throws at once") {
				await entered.promise;
				// The hook runs before the commit: nothing names the thing yet.
				assert.deepEqual(markers(at.w.path), []);
				cancelled.cancel();
				release.resolve();
			}
			await creating;
			assert.deepEqual(markers(at.w.path), []);
		});
	}

	it("Astra 3: a commit cut off by its caller's cancel after the hook clears the content under the store's context", async (t) => {
		const entered = Promise.withResolvers<string>();
		const release = Promise.withResolvers<void>();
		const deleted = Promise.withResolvers<boolean>();
		const at = await markerWorld({
			create: async (thing) => {
				entered.resolve(thing);
				await release.promise;
			},
			delete: async (_thing, ctx) => deleted.resolve(ctx.abortSignal?.aborted === true),
		});
		t.after(() => at.w.close(context));
		const cancelled = withCancel(context);
		const creating = assert.rejects(
			at.store.create({ kind: Marker.name, name: "cut off", workspace: at.pi, by: source }, cancelled.context),
		);
		await entered.promise;
		cancelled.cancel();
		release.resolve();
		await creating;
		assert.equal(await deleted.promise, false, "the delete hook ran under an aborted context");
		assert.deepEqual(markers(at.w.path), []);
	});

	it("Astra 4: a thing is nobody's until its commit; its delete hook runs after what its create hook made", async (t) => {
		const entered = Promise.withResolvers<string>();
		const resume = Promise.withResolvers<void>();
		const deleted = Promise.withResolvers<void>();
		const contents = new Set<string>();
		const at = await markerWorld({
			create: async (id) => {
				entered.resolve(id);
				await resume.promise;
				contents.add(id);
			},
			delete: async (id) => {
				contents.delete(id);
				deleted.resolve();
			},
		});
		t.after(() => at.w.close(context));
		const making = at.store.create({ kind: Marker.name, name: "preparing", workspace: at.pi, by: source }, context);
		const thing = await entered.promise;
		// While the hook prepares it, an unlink finds no link: nothing is removed, no delete hook runs.
		await at.store.unlink({ workspace: at.pi, thing }, context);
		resume.resolve();
		assert.equal(await making, thing);
		assert.ok(contents.has(thing));
		assert.equal((await at.store.things.one.page({ thing }, 1, context)).items.length, 1);
		await at.store.unlink({ workspace: at.pi, thing }, context);
		await deleted.promise;
		assert.deepEqual((await at.store.things.one.page({ thing }, 1, context)).items, []);
		assert.ok(!contents.has(thing), "content left after its cleanup");
	});

	it("Astra 5, Sol: a failed delete hook is tried again, after a reload and in a fresh host on the same disk", async (t) => {
		let attempts = 0;
		const first = Promise.withResolvers<void>();
		const at = await markerWorld({
			delete: async () => {
				attempts++;
				if (attempts === 1) {
					first.resolve();
					throw new Error("offline");
				}
			},
		});
		t.after(() => at.w.close(context));
		const reported = t.mock.method(console, "error", () => {});
		const thing = await at.store.create({ kind: Marker.name, name: "one", workspace: at.pi, by: source }, context);
		await at.store.unlink({ thing, workspace: at.pi }, context);
		await first.promise;
		assert.equal(reported.mock.callCount(), 1);
		// A snapshot of the committed disk, opened by a host of its own: the delete is still pending there.
		const copy = `${at.w.path}.restart`;
		snapshot(at.w.path, copy);
		const fresh = await reopen(copy, at.plugin);
		try {
			await eventually(
				() => attempts,
				(count) => count >= 2,
			);
		} finally {
			await fresh.close();
		}
		// The first host tries again too, after a reload of the plugin.
		await at.w.reload(THINGS.name, context);
		await at.w.host.get(ThingsStore, {}, context);
		await eventually(
			() => attempts,
			(count) => count >= 3,
		);
		await eventually(
			() => at.w.rows("pending").length,
			(count) => count === 0,
		);
	});

	it("a failed delete hook is tried again after a while, in the same store object", async (t) => {
		let attempts = 0;
		const at = await markerWorld({
			delete: async () => {
				attempts++;
				if (attempts === 1) throw new Error("offline");
			},
		});
		t.after(() => at.w.close(context));
		t.mock.method(console, "error", () => {});
		const thing = await at.store.create({ kind: Marker.name, name: "one", workspace: at.pi, by: source }, context);
		await at.store.unlink({ thing, workspace: at.pi }, context);
		await eventually(
			() => at.w.rows("pending").length,
			(count) => count === 0,
			3000,
		);
		assert.equal(attempts, 2);
	});

	it("Astra 5: a delete whose kind no plugin contributes waits for it, and runs once it is back", async (t) => {
		let calls = 0;
		const at = await markerWorld({ delete: async () => void calls++ });
		t.after(() => at.w.close(context));
		const thing = await at.store.create({ kind: Marker.name, name: "one", workspace: at.pi, by: source }, context);
		await at.w.reload(
			"marker",
			context,
			defineFacet(() => {}),
		);
		await at.store.unlink({ thing, workspace: at.pi }, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(calls, 0);
		assert.equal(at.w.rows("pending").length, 1);
		await at.w.reload("marker", context, at.plugin.facet);
		await eventually(
			() => calls,
			(count) => count === 1,
		);
		await eventually(
			() => at.w.rows("pending").length,
			(count) => count === 0,
		);
	});

	it("a kind with no delete hook needs none: its pending delete goes at once", async (t) => {
		const at = await markerWorld({});
		t.after(() => at.w.close(context));
		const thing = await at.store.create({ kind: Marker.name, name: "one", workspace: at.pi, by: source }, context);
		await at.store.unlink({ thing, workspace: at.pi }, context);
		await eventually(
			() => at.w.rows("pending").length,
			(count) => count === 0,
		);
	});

	it("a crash between the create hook and the commit leaves no row (the kind's content, if any, nobody can reach)", async (t) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const at = await markerWorld({
			create: async () => {
				entered.resolve();
				await release.promise;
				throw new Error("cut off");
			},
		});
		t.after(() => at.w.close(context));
		const creating = assert.rejects(
			at.store.create({ kind: Marker.name, name: "cut off", workspace: at.pi, by: source }, context),
		);
		await entered.promise;
		const copy = `${at.w.path}.crash`;
		snapshot(at.w.path, copy);
		release.resolve();
		await creating;
		assert.deepEqual(markers(copy), []);
		assert.deepEqual(storedRows(copy, "pending"), []);
		// The next start finds nothing to do: no row names the thing, nothing waits for a hook.
		let deletes = 0;
		const fresh = await reopen(copy, marker({ delete: async () => void deletes++ }));
		try {
			assert.equal((await fresh.store.links.here.page({ workspace: at.pi }, 10, context)).items.length, 0);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(deletes, 0);
		} finally {
			await fresh.close();
		}
	});

	it("Astra 1: a cold Gives is one generation: a commit of two boards while it loads shows both or neither", async (t) => {
		const database = await openStore(sqliteBackend(new NodeSqliteDatabase(new DatabaseSync(":memory:"))), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store: database,
			onError: (error) => assert.fail(`host error ${error.kind}`),
		});
		t.after(async () => {
			await host.close(context);
			await database.close(context);
		});
		await host.load([THINGS, BOARD], context);
		const s = await host.get(ThingsStore, {}, context);
		const root = (await s.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const leaf = await s.createWorkspace({ parent: root, name: "leaf", kind: "things.workspace", by: BY }, context);
		const p = await s.createPerson({ name: "p", madeBy: BY }, context);
		const party = { kind: "person", person: p } as const;
		await s.putParty({ workspace: root, party, source: BY }, context);
		const make = (workspace: string) => s.create({ workspace, name: "x", kind: Board.name, by: BY }, context);
		const [a, b] = [await make(root), await make(leaf)];
		// The fifth read of the cold load (the leaf's grants) is held after it read, with no lock held.
		const reached = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let reads = 0;
		const read = database.read.bind(database);
		database.read = async <T>(fn: Parameters<typeof database.read<T>>[0], c: Context) => {
			const rows = await read(fn, c);
			if (++reads === 5) {
				reached.resolve();
				await resume.promise;
			}
			return rows;
		};
		const pending = host.get(Gives, { workspace: leaf, caller: `person:${p}` }, context);
		await reached.promise;
		const grants = [
			{ thing: a, workspace: root },
			{ thing: b, workspace: leaf },
		].map((at) => ({ ...at, party, ticks: ["read", "write"], gives: true, takenAway: [] }));
		const update = s.setGrants({ source: BY, grants }, context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		resume.resolve();
		const gives = await pending;
		const first = gives.answers.value;
		await update;
		try {
			assert.deepEqual(first[a], first[b], "the two boards changed in one transaction");
			assert.deepEqual(gives.answers.value[a], { ticks: ["read", "write"] });
			assert.deepEqual(gives.answers.value[b], { ticks: ["read", "write"] });
		} finally {
			gives.release();
		}
	});
});
