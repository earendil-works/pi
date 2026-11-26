// Stored ticks at a kind's ticks version now (`migration.ts`, item 105), as the index reads them and the store writes
// them back: a new contract version leaves them as written, a new ticks version migrates them on load without touching
// the disk; rows that cannot be read count for nothing and are reported once, a withheld one failing closed; a
// migration that throws refuses only its own rows; `OPEN` never goes through a migration; the next write of a party's
// rows writes their older rows back at the version now; and while a kind's new ticks version loads, no object is built
// from old names under their new meaning, and no answer mixes the two versions.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
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
} from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { Gives, ThingsStore } from "../contract.server.ts";
import { OPEN, type Party, type Source } from "../contract.ts";
import { defineThing, ThingKinds } from "../kind.ts";
import { serveThing } from "../serve.ts";
import { BOARD, BOARD_PLUGIN, Board } from "./kinds.ts";
import { RUNTIME, THINGS, type World, world } from "./world.ts";

const BY: Source = { kind: "plugin", plugin: "test" };
const label = (key: string) => ({ namespace: "test", key, params: [] });

let w: World;
let store: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	w = await world(context);
	store = await w.host.get(ThingsStore, {}, context);
	pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
});

afterEach(() => w.close(context));

/** The test kind's next version: `draw` renamed `paint`, its ticks at `ticksVersion` with `migrateTicks`. */
function next(ticksVersion: number, migrateTicks?: (ticks: readonly string[], from: number) => string[]) {
	return defineThing(Board.name, {
		version: 2,
		methods: { read: method(), paint: method(), write: method() },
		ticks: {
			read: { label: label("read"), gives: ["read"] },
			paint: { label: label("paint"), gives: ["paint"] },
			write: { label: label("write"), gives: ["write"] },
		},
		defaultGrants: { everyone: ["read"], agents: ["read"] },
		ticksVersion,
		...(migrateTicks === undefined ? {} : { migrateTicks }),
	});
}

/** `draw` read as `paint`. */
const rename = (ticks: readonly string[]) => ticks.map((tick) => (tick === "draw" ? "paint" : tick));

/** A facet serving `kind` (from `next`). */
const facetOf = (kind: ReturnType<typeof next>) =>
	defineFacet((host) =>
		serveThing(host, kind, {
			implement: () => ({ read: async () => null, paint: async () => null, write: async () => null }),
		}),
	);

/** A person put into Pi, as a party. */
async function personIn(name: string): Promise<{ id: string; party: Party }> {
	const id = await store.createPerson({ name, madeBy: BY }, context);
	const party: Party = { kind: "person", person: id };
	await store.putParty({ workspace: pi, party, source: BY }, context);
	return { id, party };
}

/** Writes `party`'s rows of `ticks` on `thing` in Pi (`gives` left out: the rows removed). */
const write = (thing: string, party: Party, ticks: string[], gives?: boolean) =>
	store.setGrants(
		{
			source: BY,
			grants: ticks.map((tick) => ({
				workspace: pi,
				thing,
				party,
				tick,
				...(gives === undefined ? {} : { gives }),
			})),
		},
		context,
	);

/** The stored rows of `party` on `thing`: `tick/ticksVersion` (and `!` for a withheld one), sorted. */
const rowsOf = (thing: string, party: Party) =>
	w
		.rows("grants")
		.filter((row) => row.thing === thing && String(row.party) === JSON.stringify(party))
		.map((row) => `${row.gives === 1 ? "" : "!"}${row.tick}/${row.ticksVersion}`)
		.sort();

/** The lines reported about grants that count for nothing. */
function refusals(t: TestContext) {
	const reported = t.mock.method(console, "error", () => {});
	return () => reported.mock.calls.filter((call) => String(call.arguments[0]).includes("counts for nothing")).length;
}

describe("reading stored ticks", () => {
	it("a new contract version leaves them as written; a new ticks version migrates them on load, the disk unchanged (9a)", async () => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["draw", "read"], true);
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		assert.deepEqual(gives.answers.value[thing], { kind: Board.name, ticksVersion: 1, ticks: ["draw", "read"] });
		const before = w.rows("grants");
		// Contract version 2, ticks version 1: read as written; `draw` is no tick of it and is ignored.
		await w.reload(BOARD_PLUGIN, context, facetOf(next(1)));
		await until(gives.answers, (answers) => answers[thing]?.ticks.join() === "read", within("as written", context));
		// Ticks version 2: `draw` reads as `paint`, and nothing on disk changed.
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, rename)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("the migration", context));
		assert.deepEqual(gives.answers.value[thing], { kind: Board.name, ticksVersion: 2, ticks: ["paint", "read"] });
		assert.deepEqual(w.rows("grants"), before);
		gives.release();
	});

	it("a migration that throws for one grant refuses that one only, reported once; the others read (5a)", async (t) => {
		const [ada, kim] = [await personIn("Ada"), await personIn("Kim")];
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["draw"], true);
		await write(thing, kim.party, ["write"], true);
		const ask = async (id: string) => {
			const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${id}` }, context);
			try {
				return gives.answers.value[thing]?.ticks;
			} finally {
				gives.release();
			}
		};
		const refused = refusals(t);
		const throwing = (ticks: readonly string[]) => {
			if (ticks.includes("write")) throw new Error("cannot migrate write");
			return rename(ticks);
		};
		const kims = await w.host.get(Gives, { workspace: pi, caller: `person:${kim.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, throwing)));
		await until(kims.answers, (answers) => answers[thing]?.ticksVersion === 2, within("the migration", context));
		kims.release();
		// Ada's draw migrates; Kim's write is refused (she keeps everyone's read).
		assert.deepEqual(await ask(ada.id), ["paint", "read"]);
		assert.deepEqual(await ask(kim.id), ["read"]);
		await store.putParty({ workspace: pi, party: { kind: "agent", session: "s" }, source: BY }, context);
		assert.equal(refused(), 1);
	});

	it("a grant of a newer ticks version (the plugin went back) gives nothing, and a withheld one withholds every tick", async (t) => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, { kind: "everyone" }, ["draw"], true);
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		// At ticks version 2 (an identity migration): Draw withheld from Ada, Write given to her.
		const same = defineThing(Board.name, {
			version: 1,
			methods: { read: method(undefined, str()), draw: method(), write: method() },
			ticks: {
				read: { label: label("read"), gives: ["read"] },
				draw: { label: label("draw"), gives: ["draw"] },
				write: { label: label("write"), gives: ["write"] },
			},
			defaultGrants: { everyone: ["read"] },
			ticksVersion: 2,
			migrateTicks: (ticks) => [...ticks],
		});
		await w.reload(
			BOARD_PLUGIN,
			context,
			defineFacet((host) =>
				serveThing(host, same, {
					implement: () => ({ read: async () => "", draw: async () => null, write: async () => null }),
				}),
			),
		);
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		await write(thing, ada.party, ["draw"], false);
		await write(thing, ada.party, ["write"], true);
		await until(
			gives.answers,
			(answers) => answers[thing]?.ticks.join() === "read,write",
			within("withheld", context),
		);
		// Back at version 1: her rows (version 2) cannot be read. The giving one gives nothing; the withheld one
		// withholds every tick of the kind from her (fail closed), so everyone's Draw does not come back.
		const refused = refusals(t);
		await w.reload(BOARD_PLUGIN, context, BOARD.facet);
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 1, within("version 1", context));
		assert.deepEqual(gives.answers.value[thing]?.ticks, []);
		assert.equal(refused(), 2);
		gives.release();
	});

	it("the rows of one party, source and `gives` value migrate together, as one list", async () => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["draw", "write"], true);
		// Draw and Write together became Paint; either alone means nothing now.
		const merge = (ticks: readonly string[]) =>
			ticks.includes("draw") && ticks.includes("write") ? ["paint"] : ticks.filter((tick) => tick === "read");
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, merge)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		assert.deepEqual(gives.answers.value[thing]?.ticks, ["paint", "read"]);
		gives.release();
	});

	it("`OPEN` rows never go through a migration: a party let in with no tick stays so", async () => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		// The kind's Read row for everyone removed: Ada is let in by her `OPEN` row only.
		const kindPlugin: Source = { kind: "plugin", plugin: BOARD_PLUGIN };
		await store.setGrants(
			{ source: kindPlugin, grants: [{ workspace: pi, thing, party: { kind: "everyone" }, tick: "read" }] },
			context,
		);
		await store.setGrants(
			{ source: BY, grants: [{ workspace: pi, thing, party: ada.party, tick: OPEN, gives: true }] },
			context,
		);
		const seen: string[][] = [];
		const recording = (ticks: readonly string[]) => {
			seen.push([...ticks]);
			return rename(ticks);
		};
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, recording)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		assert.deepEqual(gives.answers.value[thing]?.ticks, []);
		assert.ok(!seen.flat().includes(OPEN), JSON.stringify(seen));
		gives.release();
	});
});

describe("writing stored ticks back", () => {
	it("the next write of a party's rows writes their older rows back at the version now; a reset leaves none", async () => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["draw", "read"], true);
		await write(thing, ada.party, ["write"], false);
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, rename)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		gives.release();
		assert.deepEqual(rowsOf(thing, ada.party), ["!write/1", "draw/1", "read/1"]);
		// Paint given again under its name now: her rows are written back first, so it is one row, not two.
		await write(thing, ada.party, ["paint"], true);
		assert.deepEqual(rowsOf(thing, ada.party), ["!write/2", "paint/2", "read/2"]);
		// Reset by its name now: no row of the old name is left behind.
		await write(thing, ada.party, ["paint"]);
		assert.deepEqual(rowsOf(thing, ada.party), ["!write/2", "read/2"]);
	});

	it("a given and a withheld tick migrating to one tick: it stays withheld on disk, as it reads", async () => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["draw", "read"], true);
		await write(thing, ada.party, ["write"], false);
		// Draw and Write both became Paint: given and withheld at once, the withheld one wins.
		const merge = (ticks: readonly string[]) =>
			ticks.map((tick) => (tick === "draw" || tick === "write" ? "paint" : tick));
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, merge)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		assert.deepEqual(gives.answers.value[thing]?.ticks, ["read"]);
		// The next write of her rows writes them back: Paint stays withheld, it does not come back to her.
		await write(thing, ada.party, ["read"], true);
		assert.deepEqual(rowsOf(thing, ada.party), ["!paint/2", "read/2"]);
		await until(gives.answers, (answers) => answers[thing] !== undefined, within("written back", context));
		assert.deepEqual(gives.answers.value[thing]?.ticks, ["read"]);
		gives.release();
	});

	it("a migrated tick named like another old row is kept: the old rows go first, then the new ones are put", async () => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["write"], false);
		await write(thing, ada.party, ["draw", "read"], true);
		// Write became Read, Read became Write, Draw became Paint: the withheld Read lands where the old Read was.
		const swap = (ticks: readonly string[]) =>
			ticks.map((tick) => ({ write: "read", read: "write", draw: "paint" })[tick] ?? tick);
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, swap)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		gives.release();
		await write(thing, ada.party, ["paint"], true);
		assert.deepEqual(rowsOf(thing, ada.party), ["!read/2", "paint/2", "write/2"]);
	});

	it("a withheld old tick written back over a row of it at the version now: withheld, as it reads", async (t) => {
		t.mock.method(console, "error", () => {});
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["draw"], false);
		// Version 2 with a migration that throws for Draw (a plugin bug): her withheld row is refused, kept on disk.
		const throwing = (ticks: readonly string[]) => {
			if (ticks.includes("draw")) throw new Error("cannot migrate draw");
			return rename(ticks);
		};
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, throwing)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		// The same source gives her Paint at version 2 beside it.
		await write(thing, ada.party, ["paint"], true);
		assert.deepEqual(rowsOf(thing, ada.party), ["!draw/1", "paint/2"]);
		// The plugin's fix at the same ticks version: her old row reads as a withheld Paint, which wins.
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, rename)));
		await until(gives.answers, (answers) => answers[thing]?.ticks.join() === "read", within("withheld", context));
		// Her next write writes the old row back: Paint stays withheld.
		await write(thing, ada.party, ["read"], true);
		assert.deepEqual(rowsOf(thing, ada.party), ["!paint/2", "read/2"]);
		assert.deepEqual(gives.answers.value[thing]?.ticks, ["read"]);
		gives.release();
	});

	it("a party let in by `OPEN` only: its write-back calls no migration and makes no tick", async () => {
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, [OPEN], true);
		// A migration that makes Paint out of nothing: never called without a named tick.
		const seen: string[][] = [];
		const fromNothing = (ticks: readonly string[]) => {
			seen.push([...ticks]);
			return ticks.length === 0 ? ["paint"] : [...ticks];
		};
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(BOARD_PLUGIN, context, facetOf(next(2, fromNothing)));
		await until(gives.answers, (answers) => answers[thing]?.ticksVersion === 2, within("version 2", context));
		assert.ok(!gives.answers.value[thing]?.ticks.includes("paint"));
		gives.release();
		await write(thing, ada.party, ["read"], true);
		assert.deepEqual(rowsOf(thing, ada.party), ["@open/2", "read/2"]);
		assert.ok(!seen.some((ticks) => ticks.length === 0), JSON.stringify(seen));
	});
});

describe("a kind's new ticks version while it loads", () => {
	it("no object is built from a grant's old tick name under its new meaning", async () => {
		// Many loaded workspaces make the index's re-read after a kinds change take a while.
		for (let i = 0; i < 150; i++) {
			const space = await store.createWorkspace(
				{ kind: "things.workspace", name: `w${i}`, parent: pi, by: BY },
				context,
			);
			w.host.hold(Gives, { workspace: space, caller: "person:nobody" }, context);
		}
		const ada = await personIn("Ada");
		const thing = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await write(thing, ada.party, ["draw"], true);
		// Version 2: what was `draw` is `sketch` now; the name `draw` now gives Moderate's members.
		const v2 = defineThing(Board.name, {
			version: 1,
			state: { title: str(), notes: obj({ text: str() }) },
			methods: {
				read: method(undefined, str()),
				write: method(),
				draw: method(),
				moderate: method(),
				bash: method(),
				look: method(),
			},
			ticks: {
				read: { label: label("read"), gives: ["read"] },
				write: { label: label("write"), gives: ["write"] },
				sketch: { label: label("sketch"), gives: ["draw"] },
				draw: { label: label("draw"), gives: ["moderate", "notes"] },
				bash: { label: label("bash"), for: "agents", gives: ["bash"] },
				look: { label: label("look"), for: "people", gives: ["look"] },
			},
			defaultGrants: { everyone: ["read"], agents: ["read"] },
			ticksVersion: 2,
			migrateTicks: (ticks) => ticks.map((tick) => (tick === "draw" ? "sketch" : tick)),
		});
		const built: string[] = [];
		const principal: P3Principal = { kind: "person", id: ada.id, name: "Ada" };
		await w.host.root(
			async (ctx) => {
				const ref = await ctx.get(Board.contract, { workspace: pi, thing });
				await w.reload(
					BOARD_PLUGIN,
					context,
					defineFacet((host) =>
						serveThing(host, v2, {
							implement: ({ thing: id }, { granted }) => {
								built.push([...granted].sort().join());
								return {
									title: constant(id),
									notes: () => constant({ text: "" }),
									read: async () => "",
									write: async () => null,
									draw: async () => null,
									moderate: async () => null,
									bash: async () => null,
									look: async () => null,
								};
							},
						}),
					),
				);
				await until(
					ref.state,
					(state) => state.kind === "live" && built.length > 0,
					within("rebuilt at version 2", context, 10_000),
				);
			},
			context,
			{ principal },
		);
		assert.ok(!built.some((granted) => granted.includes("moderate")), JSON.stringify(built));
		assert.ok(built.at(-1)?.includes("draw"), JSON.stringify(built));
	});

	it("an answer loading while the kind changes is one version: two things of one kind read alike", async (t) => {
		const Marker = (ticksVersion: number) =>
			defineThing("test.marker", {
				version: 1,
				ticksVersion,
				ticks: { teal: { label: label("teal") }, blue: { label: label("blue") } },
				defaultGrants: { everyone: ["teal"] },
				...(ticksVersion === 1 ? {} : { migrateTicks: () => ["blue"] }),
			});
		const marker = (ticksVersion: number) => ({
			name: "marker",
			facet: defineFacet((host) => serveThing(host, Marker(ticksVersion), { implement: () => ({}) })),
		});
		const database = await openStore(sqliteBackend(new NodeSqliteDatabase(new DatabaseSync(":memory:"))), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store: database,
			onError: (error) => assert.fail(error.kind),
		});
		t.after(async () => {
			await host.close(context);
			await database.close(context);
		});
		await host.load([RUNTIME, THINGS, marker(1)], context);
		const s = await host.get(ThingsStore, {}, context);
		const root = (await s.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const leaf = await s.createWorkspace({ parent: root, name: "leaf", kind: "things.workspace", by: BY }, context);
		const p = await s.createPerson({ name: "p", madeBy: BY }, context);
		await s.putParty({ workspace: root, party: { kind: "person", person: p }, source: BY }, context);
		const make = (workspace: string) => s.create({ workspace, name: "m", kind: "test.marker", by: BY }, context);
		const [a, b] = [await make(root), await make(leaf)];
		// The cold load's sixth read (into the leaf's entries) is held, with no lock held, while the kind changes.
		const reached = Promise.withResolvers<void>();
		const unblock = Promise.withResolvers<void>();
		const read = database.read.bind(database);
		let reads = 0;
		database.read = async <T>(fn: Parameters<typeof database.read<T>>[0], c: Context) => {
			const result = await read(fn, c);
			if (++reads === 6) {
				reached.resolve();
				await unblock.promise;
			}
			return result;
		};
		const pending = host.get(Gives, { workspace: leaf, caller: `person:${p}` }, context);
		await reached.promise;
		const kinds = await host.registry(ThingKinds, context);
		const reloading = host.reload([RUNTIME, THINGS, marker(2)], context);
		try {
			await until(
				kinds,
				(table) => table.get("test.marker")?.value.ticksVersion === 2,
				within("the kind changed", context),
			);
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			unblock.resolve();
		}
		const gives = await pending;
		const first = gives.answers.value;
		await reloading;
		await until(
			gives.answers,
			(answers) => answers[a]?.ticks[0] === "blue" && answers[b]?.ticks[0] === "blue",
			within("both blue", context),
		);
		assert.deepEqual(first[a], first[b]);
		gives.release();
	});
});
