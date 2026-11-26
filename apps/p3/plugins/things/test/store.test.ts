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
	constant,
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	method,
	obj,
	openStore,
	type P3Principal,
	type Reference,
	Server,
	sqliteBackend,
	str,
	until,
	withCancel,
} from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { Gives, OneThing, type ThingHook, ThingHooks, ThingsStore } from "../contract.server.ts";
import { OPEN, type Source } from "../contract.ts";
import { defineThing, ThingKinds } from "../kind.ts";
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

/** `promise`, or a failure after `ms`: a test that waits for a hook fails instead of hanging. */
function soon<T>(promise: Promise<T>, ms = 3000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The grant rows on disk of `thing` (in `workspace`, if given): party and source parsed. */
function grantsOf(thing: string, workspace?: string) {
	return w
		.rows("grants")
		.filter((row) => row.thing === thing && (workspace === undefined || row.workspace === workspace))
		.map((row) => ({
			workspace: String(row.workspace),
			party: JSON.parse(String(row.party)) as { kind: string },
			source: JSON.parse(String(row.source)) as Source,
			tick: String(row.tick),
			gives: row.gives === 1,
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
		// One row per tick (item 112).
		const summary = grants.map(({ party, source, tick }) => `${party.kind} ${source.kind} ${tick}`).sort();
		assert.deepEqual(summary, [
			"agents plugin read",
			"everyone plugin read",
			"person person draw",
			"person person look",
			"person person moderate",
			"person person read",
			"person person write",
		]);
		assert.ok(grants.every(({ ticksVersion, gives }) => ticksVersion === 1 && gives));
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
		await eventually(
			() => HOOKS,
			(hooks) => hooks.join() === [`create ${thing}`, `delete ${thing}`].join(),
		);
		assert.deepEqual(
			w.rows("things").filter(({ kind }) => kind === Board.name),
			[],
		);
		await eventually(
			() => w.rows("pending").length,
			(count) => count === 0,
		);
	});

	it("a thing goes with its last link: its grants and switches everywhere, then its kind's delete hook", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		await store.link({ workspace: team, thing }, context);
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
						{ workspace: pi, thing, party, tick: "read", gives: true },
						{ workspace: pi, thing, party: { kind: "everyone" }, tick: "read" },
						{ workspace: pi, thing, party, tick: "fly", gives: true },
					],
				},
				context,
			),
			/has no tick fly/,
		);
		assert.deepEqual(grantsOf(thing), before);
	});
});

describe("a plugin's one thing", () => {
	const label = { namespace: "test", key: "use", params: [] };
	const Machine = defineThing("test.machine", {
		version: 1,
		methods: { use: method() },
		state: { folder: str() },
		ticks: { use: { label, gives: ["use"] } },
		settings: ["folder"],
	});
	/** A world with the machine kind's plugin, its hooks recorded in `calls`; `create` runs before each create hook. */
	const machineWorld = async (calls: string[], one?: { name: string }, create?: () => Promise<void>) => {
		const facet = defineFacet((host) =>
			serveThing(host, Machine, {
				implement: () => ({ folder: constant("/"), use: async () => null }),
				create: async (thing) => {
					calls.push(`create ${thing}`);
					await create?.();
				},
				configure: async (thing, settings) => void calls.push(`configure ${thing} ${JSON.stringify(settings)}`),
				delete: async (thing) => void calls.push(`delete ${thing}`),
				...(one === undefined ? {} : { one }),
			}),
		);
		const at = await world(context, [{ name: "machine", facet }]);
		const things = await at.host.get(ThingsStore, {}, context);
		const root = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		return { w: at, store: things, pi: root, facet };
	};
	const machines = (path: string) => storedRows(path, "things").filter(({ kind }) => kind === Machine.name);

	it("is seeded in Pi at the start, made by its plugin, once; ensure answers it; a reload makes no second", async (t) => {
		const calls: string[] = [];
		const at = await machineWorld(calls, { name: "This machine" });
		t.after(() => at.w.close(context));
		// Seeded at the start, before anyone asks.
		await eventually(
			() => machines(at.w.path).length,
			(count) => count === 1,
		);
		const [row] = machines(at.w.path);
		assert.deepEqual([row?.name, row?.madeByKey], ["This machine", "plugin/machine"]);
		assert.deepEqual(
			at.w
				.rows("links")
				.filter((link) => link.thing === row?.thing)
				.map(({ workspace }) => workspace),
			[at.pi],
		);
		const [a, b] = await Promise.all([
			at.store.ensure({ kind: Machine.name }, context),
			at.store.ensure({ kind: Machine.name }, context),
		]);
		assert.deepEqual([a, b], [row?.thing, row?.thing]);
		assert.equal(calls.filter((call) => call.startsWith("create")).length, 1);
		await at.w.reload(THINGS.name, context);
		await at.w.reload("machine", context, at.facet);
		assert.equal(await (await at.w.host.get(ThingsStore, {}, context)).ensure({ kind: Machine.name }, context), a);
		assert.equal(machines(at.w.path).length, 1);
	});

	it("a kind's create input is checked against its schema and reaches its hook; one without takes none", async (t) => {
		const label = { namespace: "test", key: "use", params: [] };
		const Inbox = defineThing("test.inbox", {
			version: 1,
			ticks: { use: { label } },
			create: { input: obj({ signIn: str() }) },
		});
		const inputs: unknown[] = [];
		const at = await world(context, [
			{
				name: "inbox",
				facet: defineFacet((host) =>
					serveThing(host, Inbox, {
						implement: () => ({}),
						create: async (_thing, input) => {
							// Typed by the kind's schema.
							const signIn: string = input.signIn;
							inputs.push(signIn);
						},
					}),
				),
			},
		]);
		t.after(() => at.close(context));
		const things = await at.host.get(ThingsStore, {}, context);
		const root = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const make = (input: unknown) =>
			things.create({ kind: Inbox.name, name: "i", workspace: root, by: BY, input }, context);
		await make({ signIn: "ann" });
		await assert.rejects(make({ signIn: 1 }), /input of test.inbox/);
		await assert.rejects(
			things.create({ kind: Board.name, name: "b", workspace: root, by: BY, input: {} }, context),
			/takes no input/,
		);
		assert.deepEqual(inputs, ["ann"]);
	});

	it("ensure refuses a kind that asks for none", async (t) => {
		const at = await machineWorld([]);
		t.after(() => at.w.close(context));
		await assert.rejects(at.store.ensure({ kind: Machine.name }, context), /has no seeded thing/);
	});

	it("while the start's seed is still being made, deletes run: the lifecycle does not wait for it", async (t) => {
		const calls: string[] = [];
		const held = Promise.withResolvers<void>();
		let first = true;
		const at = await machineWorld(calls, { name: "This machine" }, async () => {
			if (first) {
				first = false;
				await held.promise;
			}
		});
		t.after(async () => {
			held.resolve();
			await at.w.close(context);
		});
		await eventually(
			() => calls.length,
			(count) => count === 1,
		);
		// An ensure meanwhile waits for the same seed: one thing, one create hook.
		const ensured = at.store.ensure({ kind: Machine.name }, context);
		const other = await at.store.create({ kind: Board.name, name: "other", workspace: at.pi, by: BY }, context);
		HOOKS.length = 0;
		await at.store.unlink({ workspace: at.pi, thing: other }, context);
		await eventually(
			() => HOOKS,
			(hooks) => hooks.includes(`delete ${other}`),
			2000,
		);
		held.resolve();
		assert.equal(await ensured, machines(at.w.path)[0]?.thing);
		assert.equal(calls.filter((call) => call.startsWith("create")).length, 1);
	});

	it("a seed that does not stand (the plugin made its thing meanwhile) has its hook's work cleared", async (t) => {
		const calls: string[] = [];
		const held = Promise.withResolvers<void>();
		let first = true;
		const at = await machineWorld(calls, { name: "This machine" }, async () => {
			if (first) {
				first = false;
				await held.promise;
			}
		});
		t.after(async () => {
			held.resolve();
			await at.w.close(context);
		});
		await eventually(
			() => calls.length,
			(count) => count === 1,
		);
		const seeded = calls[0]!.slice("create ".length);
		// Its plugin makes the thing itself while the seed's hook still prepares: that one stands.
		const made = await at.store.create(
			{ kind: Machine.name, name: "made", workspace: at.pi, by: { kind: "plugin", plugin: "machine" } },
			context,
		);
		held.resolve();
		// A deadline: a seed whose undo waits for a lifecycle that does not serve yet never ends.
		assert.equal(await soon(at.store.ensure({ kind: Machine.name }, context)), made);
		await eventually(
			() => calls,
			(done) => done.includes(`delete ${seeded}`),
		);
		assert.ok(!calls.includes(`delete ${made}`));
	});

	it("`OneThing` names it live: deleted, it is made again at once and `OneThing` names the new one", async (t) => {
		const calls: string[] = [];
		const at = await machineWorld(calls, { name: "This machine" });
		t.after(() => at.w.close(context));
		const one = await at.w.host.get(OneThing, { kind: Machine.name }, context);
		const first = await until(one.thing, (thing) => thing !== "", within("seeded", context));
		await at.store.unlink({ workspace: at.pi, thing: first }, context);
		const second = await until(one.thing, (thing) => thing !== "" && thing !== first, within("made again", context));
		assert.deepEqual(
			machines(at.w.path).map(({ thing }) => thing),
			[second],
		);
		await eventually(
			() => calls,
			(done) => done.includes(`delete ${first}`),
		);
		one.release();
	});

	it("unlinked from Pi but linked elsewhere, it stays the seeded thing", async (t) => {
		const at = await machineWorld([], { name: "This machine" });
		t.after(() => at.w.close(context));
		const leaf = await at.store.createWorkspace(
			{ kind: "things.workspace", name: "leaf", parent: at.pi, by: BY },
			context,
		);
		const thing = await at.store.ensure({ kind: Machine.name }, context);
		await at.store.link({ workspace: leaf, thing }, context);
		await at.store.unlink({ workspace: at.pi, thing }, context);
		await at.w.reload(THINGS.name, context);
		const again = await at.w.host.get(ThingsStore, {}, context);
		assert.equal(await again.ensure({ kind: Machine.name }, context), thing);
		const one = await at.w.host.get(OneThing, { kind: Machine.name }, context);
		assert.equal(await until(one.thing, (id) => id !== "", within("named", context)), thing);
		one.release();
	});

	it("a kind's settings and its configure hook are registered with it", async (t) => {
		const calls: string[] = [];
		const at = await machineWorld(calls);
		t.after(() => at.w.close(context));
		const kinds = await at.w.host.registry(ThingKinds, context);
		assert.deepEqual(kinds.value.get(Machine.name)?.value.settings, ["folder"]);
		const hooks = await at.w.host.registry(ThingHooks, context);
		const configure = hooks.value.get(Machine.name)?.value.configure;
		await at.w.host.root((ctx) => configure!("m", { folder: "/tmp" }, ctx), context);
		assert.deepEqual(calls, ['configure m {"folder":"/tmp"}']);
	});
});

describe("grant rows (item 112)", () => {
	it("a row per tick: given only where linked, withheld anywhere, removed with `gives` left out; reserved ticks but `OPEN` refused", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		const party = { kind: "group", group: "g" } as const;
		const write = (workspace: string, tick: string, gives?: boolean) =>
			store.setGrants(
				{ source: BY, grants: [{ workspace, thing, party, tick, ...(gives === undefined ? {} : { gives }) }] },
				context,
			);
		await write(pi, "draw", true);
		await write(pi, OPEN, true);
		await write(team, "draw", false);
		await assert.rejects(write(team, "draw", true), /not linked in/);
		await assert.rejects(write(pi, "@make:*", true), /has no tick @make:\*/);
		// Withheld too, a tick must be the kind's.
		await assert.rejects(write(team, "fly", false), /has no tick fly/);
		const mine = () =>
			grantsOf(thing)
				.filter(({ party: { kind } }) => kind === "group")
				.map(({ workspace, tick, gives }) => `${workspace === pi ? "pi" : "team"} ${tick} ${gives}`)
				.sort();
		assert.deepEqual(mine(), ["pi @open true", "pi draw true", "team draw false"]);
		await write(pi, "draw");
		await write(team, "draw");
		assert.deepEqual(mine(), ["pi @open true"]);
	});

	it("a kind's empty default grant lets its party in with no tick: one `OPEN` row; `guests` is written at no link", async (t) => {
		const label = { namespace: "test", key: "use", params: [] };
		const Quiet = defineThing("test.quiet", {
			version: 1,
			methods: { use: method() },
			ticks: { use: { label, gives: ["use"] } },
			defaultGrants: { everyone: [], guests: ["use"] },
		});
		const at = await world(context, [
			{
				name: "quiet",
				facet: defineFacet((host) => serveThing(host, Quiet, { implement: () => ({ use: async () => null }) })),
			},
		]);
		t.after(() => at.close(context));
		const things = await at.host.get(ThingsStore, {}, context);
		const root = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const thing = await things.create({ kind: Quiet.name, name: "q", workspace: root, by: BY }, context);
		assert.deepEqual(
			at.rows("grants").map(({ partyKey, tick }) => `${partyKey} ${tick}`),
			[`everyone ${OPEN}`],
		);
		assert.equal(thing.length > 0, true);
	});
});

describe("linking", () => {
	it("a link starts with the kind's default grants; linking again changes nothing", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		await store.link({ workspace: team, thing }, context);
		await store.link({ workspace: team, thing }, context);
		assert.deepEqual(
			grantsOf(thing, team)
				.map(({ party }) => party.kind)
				.sort(),
			["agents", "everyone"],
		);
		await assert.rejects(store.link({ workspace: team, thing: "none" }, context), /no thing none/);
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
		await things.link({ workspace: root, thing }, context);
		await assert.rejects(things.link({ workspace: team, thing }, context), /linked in one workspace only/);
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
						tick: "read",
						gives: true,
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

describe("races, failures and restarts", () => {
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

	it("two unlinks at once of a thing's two links remove it", async () => {
		const leaf = await store.createWorkspace({ parent: pi, name: "leaf", kind: "things.workspace", by: BY }, context);
		const thing = await store.create({ workspace: pi, kind: Board.name, name: "two", by: BY }, context);
		await store.link({ workspace: leaf, thing }, context);
		await Promise.all([
			store.unlink({ workspace: pi, thing }, context),
			store.unlink({ workspace: leaf, thing }, context),
		]);
		assert.deepEqual((await store.things.one.page({ thing }, 1, context)).items, []);
	});

	for (const mode of ["throws at once", "rejects after its caller cancelled"] as const) {
		it(`a create hook that ${mode} leaves no thing`, async (t) => {
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

	it("the create hook is told who makes the thing, and may refuse them", async (t) => {
		const told: Source[] = [];
		const at = await markerWorld({
			create: async (_thing, _input, by) => {
				told.push(by);
				// As a login refuses a sign-in that is not its maker's.
				if (by.kind === "person" && by.person === "bob") throw new Error("not your sign-in");
			},
		});
		t.after(() => at.w.close(context));
		const ann: Source = { kind: "person", person: "ann" };
		await at.store.create({ kind: Marker.name, name: "ann's", workspace: at.pi, by: ann }, context);
		await assert.rejects(
			at.store.create(
				{ kind: Marker.name, name: "bob's", workspace: at.pi, by: { kind: "person", person: "bob" } },
				context,
			),
			/not your sign-in/,
		);
		assert.deepEqual(told, [ann, { kind: "person", person: "bob" }]);
		assert.deepEqual(
			markers(at.w.path).map(({ name }) => name),
			["ann's"],
		);
	});

	it("a commit cut off by its caller's cancel after the hook clears the content under the store's context", async (t) => {
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
		assert.equal(await soon(deleted.promise), false, "the delete hook ran under an aborted context");
		assert.deepEqual(markers(at.w.path), []);
	});

	it("a thing is nobody's until its commit; its delete hook runs after what its create hook made", async (t) => {
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
		await soon(deleted.promise);
		assert.deepEqual((await at.store.things.one.page({ thing }, 1, context)).items, []);
		assert.ok(!contents.has(thing), "content left after its cleanup");
	});

	it("a failed delete hook is tried again, after a reload and in a fresh host on the same disk", async (t) => {
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

	it("a kind's plugin withdrawn while its create hook prepares a thing: the cleanup stays due until it is back", async (t) => {
		const entered = Promise.withResolvers<string>();
		const release = Promise.withResolvers<void>();
		const content = new Set<string>();
		const at = await markerWorld({
			create: async (id) => {
				content.add(id);
				entered.resolve(id);
				await release.promise;
			},
			delete: async (id) => void content.delete(id),
		});
		t.after(() => at.w.close(context));
		const making = assert.rejects(
			at.store.create({ kind: Marker.name, name: "m", workspace: at.pi, by: source }, context),
			/no kind/,
		);
		const id = await entered.promise;
		await at.w.reload(
			"marker",
			context,
			defineFacet(() => {}),
		);
		release.resolve();
		await making;
		assert.ok(content.has(id));
		assert.equal(at.w.rows("pending").length, 1);
		await at.w.reload("marker", context, at.plugin.facet);
		await eventually(
			() => content.has(id),
			(left) => !left,
		);
		await eventually(
			() => at.w.rows("pending").length,
			(count) => count === 0,
		);
	});

	it("one thing's delete hook never runs twice at once: not on a hooks change, nor across a store reload", async (t) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		let calls = 0;
		const hooks = {
			delete: async () => {
				peak = Math.max(++active, peak);
				if (++calls === 1) {
					entered.resolve();
					await release.promise;
				}
				active--;
			},
		};
		const at = await markerWorld(hooks);
		t.after(() => at.w.close(context));
		const thing = await at.store.create({ kind: Marker.name, name: "m", workspace: at.pi, by: source }, context);
		await at.store.unlink({ thing, workspace: at.pi }, context);
		await entered.promise;
		// The hooks change (the kind's plugin reloads with a second kind): pending deletes are resumed, this one not a
		// second time.
		const Extra = defineThing("test.extra", { version: 1, ticks: { mark: { label } } });
		await at.w.reload(
			"marker",
			context,
			defineFacet((host) => {
				serveThing(host, Marker, { implement: () => ({}), delete: hooks.delete });
				serveThing(host, Extra, { implement: () => ({}) });
			}),
		);
		// The resume runs after the reload, beside the hook still running.
		await new Promise((resolve) => setTimeout(resolve, 200));
		// The store reloads while the hook runs: the next attempt resumes only after this one's hooks ended.
		const reloading = at.w.reload(THINGS.name, context);
		await new Promise((resolve) => setTimeout(resolve, 200));
		release.resolve();
		await reloading;
		await at.w.host.get(ThingsStore, {}, context);
		await eventually(
			() => at.w.rows("pending").length,
			(count) => count === 0,
		);
		assert.equal(peak, 1);
	});

	it("a delete whose kind no plugin contributes waits for it, and runs once it is back", async (t) => {
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

	it("a cold Gives is one generation: a commit of two boards while it loads shows both or neither", async (t) => {
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
		].flatMap((at) => ["read", "write"].map((tick) => ({ ...at, party, tick, gives: true })));
		const update = s.setGrants({ source: BY, grants }, context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		resume.resolve();
		const gives = await pending;
		const first = gives.answers.value;
		await update;
		try {
			assert.deepEqual(first[a], first[b], "the two boards changed in one transaction");
			assert.deepEqual(gives.answers.value[a]?.ticks, ["read", "write"]);
			assert.deepEqual(gives.answers.value[b]?.ticks, ["read", "write"]);
		} finally {
			gives.release();
		}
	});
});
