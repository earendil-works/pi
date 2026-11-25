// Lists (slice 14 §4, test list `host/list` and 19): pages between fixed bookmarks. After every published frame of
// randomized runs (touches, inserts, deletes, bulk writes, group commits) the list's value is a gapless,
// duplicate-free prefix of the true order, and the whole order when `moreAfter` is false. `more` adds only inserts;
// a row moving between pages is one move; the last page is open while no row is behind it; pages split and merge
// without changing a row; overflow shows a prefix; arguments that follow a value switch every page in one frame; a
// reload keeps the bookmarks.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, hostKind, int, local, method, obj, queries, remote, str } from "../../src/contracts/index.ts";
import { applyImmutable } from "../../src/delta/index.ts";
import {
	createHost,
	defineFacet,
	type FacetHost,
	type Host,
	type HostError,
	type StoreSelf,
} from "../../src/host/index.ts";
import { List } from "../../src/host/list.ts";
import { ownQueries } from "../../src/host/named-query.ts";
import { resolveWatchable } from "../../src/host/reference.ts";
import type { JsonValue } from "../../src/json.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import type { Source, Subscriber } from "../../src/state/internal.ts";
import { eq } from "../../src/store/expression.ts";
import { query } from "../../src/store/query.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import type { WatchCall } from "../../src/watch.ts";
import { changesOf, delivered, expectCollected, flushed, instancesOf, memoryStore, transported } from "../support.ts";

const Rows = defineTable("rows", {
	version: 1,
	columns: { id: int(), group: str(), touched: int(), title: str({ default: "" }) },
	key: ["id"],
	indexes: { by_group: ["group", "touched"] },
});
const Item = obj({ id: int(), touched: int() });
const Row = obj({ id: int(), group: str(), touched: int() });

const Store = local("app.rows", {
	version: 1,
	params: {},
	members: {
		rows: queries(Item, { ofGroup: obj({ group: str() }) }),
		write: method(arr(obj({ put: Row }))),
		touch: method(obj({ id: int(), at: int() })),
		drop: method(int()),
		clear: method(str()),
	},
});
const Screen = local("app.screen", {
	version: 1,
	params: { view: str() },
	members: {
		list: obj({ rows: arr(Item), moreAfter: bool() }),
		more: method(),
		show: method(str()),
	},
});

const Server = hostKind("server");

/** The screen as a client holds it over a link: the list of group "a" and `more`. */
const Board = remote("app.board", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { list: obj({ rows: arr(Item), moreAfter: bool() }) },
	methods: { more: method() },
});

/** What the tests count: how often the screen's factory ran. */
type Probe = { factories: number };

/** What a test adds to the store's factory, and takes of it: more declarations (a native), its named queries. */
type StoreProbe = { declare?: (self: StoreSelf) => void; queries?: WeakRef<object>[] };

function serveStore(h: FacetHost, direction: "asc" | "desc" = "desc", probe: StoreProbe = {}): void {
	h.serve(Store, (_, self) => {
		const table = self.table(Rows);
		probe.declare?.(self);
		const rows = self.queries(
			table,
			{ map: (row) => ({ id: row.id, touched: row.touched }), reads: ["id", "touched"] },
			{
				// by_group (group, touched): the newest touched first.
				ofGroup: ({ group }: { group: string }) =>
					query(Rows)
						.where((r) => eq(r.group, group))
						.orderBy((r) => r.touched, direction),
			},
		);
		probe.queries?.push(new WeakRef(ownQueries(rows)!.get("ofGroup")!));
		return {
			rows,
			write: async (puts, ctx) => {
				await self.tx(async (tx) => {
					for (const { put } of puts) tx.put(table, put);
				}, ctx);
				return null;
			},
			touch: async ({ id, at }, ctx) => {
				await self.tx(async (tx) => tx.update(table, { id }, { touched: at }), ctx);
				return null;
			},
			drop: async (id, ctx) => {
				await self.tx(async (tx) => tx.delete(table, { id }), ctx);
				return null;
			},
			clear: async (group, ctx) => {
				await self.tx(async (tx) => tx.deleteWhere(table, (r) => eq(r.group, group)), ctx);
				return null;
			},
		};
	});
}

function serveScreen(h: FacetHost, first: number, probe: Probe = { factories: 0 }): void {
	h.serve(Screen, (_params, self) => {
		probe.factories++;
		const shown = self.writable("a");
		const args = self.derive([shown], ([group]) => ({ group }));
		const list = self.list("rows", [[self.get(Store, {}).rows.ofGroup, args]], { first });
		return {
			list: list.value,
			more: (ctx) => list.more(ctx),
			show: async (group) => {
				shown.set(group);
				return null;
			},
		};
	});
}

type Plugin = { readonly name: string; readonly facet: ReturnType<typeof defineFacet> };
const storePlugin = (direction?: "asc" | "desc", probe?: StoreProbe): Plugin => ({
	name: "@test/store",
	facet: defineFacet((h) => serveStore(h, direction, probe)),
});
const screenPlugin = (first: number, probe?: Probe): Plugin => ({
	name: "@test/screen",
	facet: defineFacet((h) => serveScreen(h, first, probe)),
});

/** A host with the store and a screen of pages of `first` rows; `seed` rows of group "a" touched at their id. */
async function hosted(first: number, seed: number, probe?: Probe, storeProbe?: StoreProbe) {
	const store: ChordStore = await memoryStore();
	const host: Host = createHost({ store, onError: () => {} });
	const plugins = { store: storePlugin(undefined, storeProbe), screen: screenPlugin(first, probe) };
	await host.load([plugins.store, plugins.screen], context);
	const rows = await host.get(Store, {}, context);
	const all = Array.from({ length: seed }, (_, index) => ({ put: { id: index + 1, group: "a", touched: index + 1 } }));
	if (all.length > 0) await rows.write(all, context);
	const screen = await host.get(Screen, { view: "v" }, context);
	const close = async (): Promise<void> => {
		await host.close(context);
		await store.close(context);
	};
	return { store, host, rows, screen, plugins, close };
}

const ids = (list: { readonly rows: readonly { readonly id: number }[] }): number[] => list.rows.map((row) => row.id);

/** A small deterministic generator (mulberry32). */
function random(seed: number): { int(below: number): number; chance(p: number): boolean } {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { int: (below) => Math.floor(next() * below), chance: (p) => next() < p };
}

describe("the invariant", () => {
	for (const seed of [1, 2, 3, 4]) {
		it(`after every frame the value is a gapless prefix of the true order (seed ${seed})`, async () => {
			const first = 5;
			const { rows, screen, close } = await hosted(first, 12);
			const r = random(seed);
			const truth = new Map<number, number>(Array.from({ length: 12 }, (_, index) => [index + 1, index + 1]));
			let clock = 100;
			let nextId = 13;
			/** The true order: newest touched first, ties by id (the key appended to the order). */
			const order = (): number[] => [...truth].sort(([a, at], [b, bt]) => bt - at || b - a).map(([id]) => id);
			const check = (step: string): void => {
				const { rows: shown, moreAfter } = screen.list.value;
				const expected = order();
				expect(ids({ rows: shown }), step).toEqual(expected.slice(0, shown.length));
				if (!moreAfter) expect(shown.length, `${step}: the whole order`).toBe(expected.length);
			};
			for (let step = 0; step < 300; step++) {
				const pending: Promise<unknown>[] = [];
				// One commit, or a group of commits queued together.
				for (let commit = r.chance(0.2) ? 3 : 1; commit > 0; commit--) {
					const kind = r.int(10);
					const live = [...truth.keys()];
					const pick = live[r.int(live.length)];
					if (kind < 4 && pick !== undefined) {
						truth.set(pick, ++clock);
						pending.push(rows.touch({ id: pick, at: clock }, context));
					} else if (kind < 6) {
						const id = nextId++;
						const at = r.chance(0.5) ? ++clock : r.int(50);
						truth.set(id, at);
						pending.push(rows.write([{ put: { id, group: "a", touched: at } }], context));
					} else if (kind < 8 && pick !== undefined) {
						truth.delete(pick);
						pending.push(rows.drop(pick, context));
					} else if (kind === 8) {
						// A bulk write of many pages' rows at once.
						const bulk = Array.from({ length: 4 * first }, () => {
							const id = nextId++;
							const at = r.chance(0.5) ? ++clock : r.int(50);
							truth.set(id, at);
							return { put: { id, group: "a", touched: at } };
						});
						pending.push(rows.write(bulk, context));
					} else pending.push(screen.more(context));
				}
				await Promise.all(pending);
				await flushed();
				check(`seed ${seed}, step ${step}`);
			}
			// Loading to the end shows the whole order.
			for (let page = 0; page < 200 && screen.list.value.moreAfter; page++) await screen.more(context);
			expect(ids(screen.list.value)).toEqual(order());
			await close();
		});
	}
});

describe("pages", () => {
	it("loads a first page, and with more only the next rows: the loaded ones are the same objects", async () => {
		const { screen, close } = await hosted(3, 8);
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[8, 7, 6], true]);
		const loaded = screen.list.value.rows;
		const watch = await screen.list.watch(context);
		const calls = changesOf(watch);
		await Promise.all([screen.more(context), screen.more(context)]);
		await delivered();
		expect(ids(screen.list.value)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
		for (const [index, row] of loaded.entries()) expect(screen.list.value.rows[index]).toBe(row);
		// Two calls in turn, each one frame that adds its page's rows.
		expect(calls.map((call) => (call.kind === "value" ? ids(call.value) : call.kind))).toEqual([
			[8, 7, 6, 5, 4, 3],
			[8, 7, 6, 5, 4, 3, 2, 1],
		]);
		watch.stop();
		await close();
	});

	it("moves a row touched in a later page to the top: one frame, no gap, no duplicate", async () => {
		const { rows, screen, close } = await hosted(3, 9);
		await screen.more(context);
		await screen.more(context);
		const watch = await screen.list.watch(context);
		const calls = changesOf(watch);
		await rows.touch({ id: 2, at: 100 }, context);
		await delivered();
		expect(ids(screen.list.value)).toEqual([2, 9, 8, 7, 6, 5, 4, 3, 1]);
		expect(calls).toHaveLength(1);
		watch.stop();
		await close();
	});

	it("a row moving between two pages sets the list once per page and publishes one frame, diffed from the value before the commit", async () => {
		const { rows, screen, close } = await hosted(3, 9);
		await screen.more(context);
		await screen.more(context);
		const before = screen.list.value as unknown as JsonValue;
		// As a link's provider side follows it: every frame in its batch, none folded (a watch folds them).
		const source = resolveWatchable(screen.list) as Source;
		const calls: WatchCall<JsonValue>[] = [];
		const subscriber: Subscriber = {
			advance: (call) => void calls.push(call),
			end: () => {},
			endAfterDelivery: () => {},
		};
		source.subscribe(subscriber);
		// Row 2 leaves the third page and enters the first: both pages adopt in one commit.
		await rows.touch({ id: 2, at: 100 }, context);
		await flushed();
		expect(calls).toHaveLength(1);
		const [call] = calls;
		if (call?.kind !== "value") throw new Error("no value call");
		expect(ids(call.value as never)).toEqual([2, 9, 8, 7, 6, 5, 4, 3, 1]);
		expect(applyImmutable(before, call.ops)).toEqual(call.value);
		source.unsubscribe(subscriber);
		await close();
	});

	it("over a link, the last row of a second page moving to the top is one state message: no protocol error, the link stays open", async () => {
		const store: ChordStore = await memoryStore();
		const errors: HostError[] = [];
		const server: Host = createHost({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (error) => errors.push(error),
		});
		const board = defineFacet((h) =>
			h.serve(Board, (_params, _principal, self) => {
				const args = self.derive([self.writable("a")], ([group]) => ({ group }));
				const list = self.list("rows", [[self.get(Store, {}).rows.ofGroup, args]], { first: 3 });
				return { list: list.value, more: (ctx) => list.more(ctx) };
			}),
		);
		await server.load([storePlugin(), { name: "@test/board", facet: board }], context);
		const rows = await server.get(Store, {}, context);
		await rows.write(
			[1, 2, 3, 4].map((id) => ({ put: { id, group: "a", touched: id } })),
			context,
		);
		const client: Host = createHost({ onError: (error) => errors.push(error) });
		await client.load([], context);
		const [up, down] = memoryLinkPair();
		server.accept(up, { principal: { kind: "owner" } }, context);
		client.connect(down, { principal: { kind: "server" } }, context);
		const held = await client.get(Board, {}, context);
		await held.more(context);
		await transported();
		expect(ids(held.list.value)).toEqual([4, 3, 2, 1]);
		// The one row of the second page becomes the first row of the first.
		await rows.touch({ id: 1, at: 100 }, context);
		await transported();
		expect(errors).toEqual([]);
		expect(held.state.value).toEqual({ kind: "live" });
		expect(ids(held.list.value)).toEqual([1, 4, 3, 2]);
		held.release();
		await client.close(context);
		await server.close(context);
		await store.close(context);
	});

	it("keeps the last page open while no row is behind it: empty, short and exactly full lists take a new row", async () => {
		for (const seed of [0, 2, 3]) {
			const { rows, screen, close } = await hosted(3, seed);
			expect([ids(screen.list.value).length, screen.list.value.moreAfter]).toEqual([seed, false]);
			// A row behind everything shown (the order is descending: the oldest touch is last).
			await rows.write([{ put: { id: 50, group: "a", touched: 0 } }], context);
			if (seed < 3) expect([ids(screen.list.value).at(-1), screen.list.value.moreAfter]).toEqual([50, false]);
			else expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[3, 2, 1], true]);
			await close();
		}
	});

	it("a stale moreAfter is corrected by a more that loads nothing; the last page is open again", async () => {
		const { rows, screen, close } = await hosted(2, 3);
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[3, 2], true]);
		// The row behind the bounded page goes: the list cannot know, and still says more.
		await rows.drop(1, context);
		expect(screen.list.value.moreAfter).toBe(true);
		await screen.more(context);
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[3, 2], false]);
		// Open at its end again: a row behind a full page is known at once, behind a short one it appears.
		await rows.write([{ put: { id: 9, group: "a", touched: 0 } }], context);
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[3, 2], true]);
		await rows.drop(9, context);
		await rows.drop(2, context);
		await screen.more(context);
		await rows.write([{ put: { id: 8, group: "a", touched: 0 } }], context);
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[3, 8], false]);
		await close();
	});

	it("shows a prefix, never a hole, while a bulk write overflows a page, and loads on by itself", async () => {
		const first = 2;
		const { rows, screen, close } = await hosted(first, 4);
		await screen.more(context);
		const watch = await screen.list.watch(context);
		const calls = changesOf(watch);
		// Twenty rows into the first page's range: more than a page reads (4 pages' rows).
		const bulk = Array.from({ length: 20 }, (_, index) => ({
			put: { id: 100 + index, group: "a", touched: 1000 + index },
		}));
		await rows.write(bulk, context);
		for (let wait = 0; wait < 20; wait++) await flushed();
		await delivered();
		const expected = [...bulk.map(({ put }) => put.id).reverse(), 4, 3, 2, 1];
		const frames = calls.map((call) => (call.kind === "value" ? call.value : { rows: [], moreAfter: false }));
		// The first frame ends at the cut and says more; every frame is a prefix; the last has everything again.
		expect([frames[0]!.rows.length, frames[0]!.moreAfter]).toEqual([4 * first, true]);
		for (const frame of frames) expect(ids(frame)).toEqual(expected.slice(0, frame.rows.length));
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([expected, false]);
		watch.stop();
		await close();
	});

	it("keeps the number of pages bounded over many touches: the rows a touch moves merge back", async () => {
		const first = 4;
		const { rows, screen, store, close } = await hosted(first, 40);
		for (let page = 0; page < 12; page++) await screen.more(context);
		expect(ids(screen.list.value)).toHaveLength(40);
		for (let touch = 0; touch < 400; touch++)
			await rows.touch({ id: 1 + ((touch * 7) % 40), at: 1000 + touch }, context);
		expect(ids(screen.list.value)).toHaveLength(40);
		// Every page is one read of the store over the table. Neighbours that hold more than one page's rows together
		// stay apart, so a page holds more than half a page on average: at most 2 × 40 / 4 pages, at least 40 / 8.
		const reads = store.reads.on("app.rows:rows")?.size ?? 0;
		expect(reads).toBeGreaterThanOrEqual(5);
		expect(reads).toBeLessThanOrEqual(20);
		await close();
	});
});

describe("arguments that follow a value", () => {
	it("switch every page in one frame, and start again at a first page of the other rows", async () => {
		const { rows, screen, close } = await hosted(2, 5);
		await rows.write(
			[6, 7, 8].map((id) => ({ put: { id, group: "b", touched: id } })),
			context,
		);
		await screen.more(context);
		const watch = await screen.list.watch(context);
		const calls = changesOf(watch);
		await screen.show("b", context);
		await flushed();
		await delivered();
		// The bookmarks are positions of the same order: the pages reopen under them, for the other group's rows.
		expect(calls).toHaveLength(1);
		expect(ids(screen.list.value)).toEqual([8, 7, 6]);
		watch.stop();
		await close();
	});
});

describe("reload", () => {
	it("of the list's plugin keeps the bookmarks: the pages it had, one value, no first-page collapse", async () => {
		const probe: Probe = { factories: 0 };
		const { rows, screen, host, plugins, close } = await hosted(3, 10, probe);
		await screen.more(context);
		await screen.more(context);
		expect(ids(screen.list.value)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2]);
		await host.reload([plugins.store, screenPlugin(3, probe)], context);
		await flushed();
		// The first activation, staging's recording run, and the successor.
		expect(probe.factories).toBe(3);
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[10, 9, 8, 7, 6, 5, 4, 3, 2], true]);
		// A write into a reopened range is one update.
		await rows.touch({ id: 5, at: 500 }, context);
		expect(ids(screen.list.value)).toEqual([5, 10, 9, 8, 7, 6, 4, 3, 2]);
		await close();
	});

	it("of the store's plugin does not restart the list: the same rows send nothing, a new order starts again", async () => {
		const probe: Probe = { factories: 0 };
		const { screen, host, plugins, close } = await hosted(3, 10, probe);
		await screen.more(context);
		const watch = await screen.list.watch(context);
		const calls = changesOf(watch);
		await host.reload([storePlugin(), plugins.screen], context);
		await flushed();
		await delivered();
		expect(probe.factories).toBe(1);
		expect(calls).toHaveLength(0);
		expect(ids(screen.list.value)).toEqual([10, 9, 8, 7, 6, 5]);
		// The new builder orders the other way: the bookmarks are of another order, the list starts again.
		await host.reload([storePlugin("asc"), plugins.screen], context);
		await flushed();
		await delivered();
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[1, 2, 3], true]);
		watch.stop();
		await close();
	});

	it("a more called while the store's successor opens waits for it: nothing is read through the retired query, and nothing of it stays", async () => {
		// Code review round 2 (Astra B2, Sol B1), through the public reload: the successor waits in its native's open,
		// after the old attempt's reads retired. `more` used the old tiling: its closed query registered a read of the
		// old code's statement, which stayed in the store's index after the screen was released.
		const old: StoreProbe = { queries: [] };
		const { screen, host, store, plugins, close } = await hosted(2, 4, undefined, old);
		expect(ids(screen.list.value)).toEqual([4, 3]);
		const [opening, opened] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const next = storePlugin("desc", {
			declare: (self) => {
				self.open(
					async () => {
						opening.resolve();
						await opened.promise;
						return null;
					},
					() => {},
				);
			},
		});
		const reloaded = host.reload([next, plugins.screen], context);
		await opening.promise;
		const registered = (): number => store.reads.on("app.rows:rows")?.size ?? 0;
		expect(registered(), "the old provider's reads retired").toBe(0);
		let completed = false;
		const more = screen.more(context).then(() => {
			completed = true;
		});
		await delivered();
		expect({ completed, registered: registered() }).toEqual({ completed: false, registered: 0 });
		opened.resolve();
		await reloaded;
		await more;
		await flushed();
		// Loaded behind the successor's pages, with its statement.
		expect([ids(screen.list.value), screen.list.value.moreAfter]).toEqual([[4, 3, 2, 1], false]);
		expect(registered()).toBeGreaterThan(0);
		// Nothing keeps the old code's query while the screen still shows the list.
		await expectCollected(old.queries![0]!);
		screen.release();
		await flushed();
		expect(registered()).toBe(0);
		await close();
	});
});

describe("declaration and memory", () => {
	it("refuses a list without a name, a second list of a name, no page size, and several sources", async () => {
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const thrown: string[] = [];
		const Bad = local("app.bad", { version: 1, params: {}, members: { n: int() } });
		const facet = defineFacet((h) => {
			serveStore(h);
			h.serve(Bad, (_, self) => {
				const source = [self.get(Store, {}).rows.ofGroup, { group: "a" }] as const;
				const attempt = (work: () => unknown): void => {
					try {
						work();
					} catch (error) {
						thrown.push((error as Error).message);
					}
				};
				// Plugin code is bundled without type checks.
				attempt(() => self.list("", [source], { first: 3 }));
				attempt(() => self.list("a", [source], {} as never));
				attempt(() => self.list("a", [source, source], { first: 3 }));
				self.list("a", [source], { first: 3 });
				attempt(() => self.list("a", [source], { first: 3 }));
				return { n: self.derive([], () => 1) };
			});
		});
		await host.load([{ name: "@test/bad", facet }], context);
		await host.get(Bad, {}, context);
		expect(thrown).toEqual([
			"app.bad: self.list: a list has a name",
			"app.bad: self.list: { first: n } is required, a positive integer",
			"app.bad: self.list: one source, [[namedQuery, args]]",
			'app.bad: list "a" is declared twice',
		]);
		await host.close(context);
		await store.close(context);
	});

	it("keeps nothing of a list once its object ended: its pages leave the store's index", async () => {
		const lists = instancesOf(List, "read");
		const { screen, store, close } = await hosted(3, 10);
		await screen.more(context);
		const list = lists.at(-1)!;
		expect(store.reads.on("app.rows:rows")?.size).toBeGreaterThan(0);
		screen.release();
		await flushed();
		await close();
		await expectCollected(list);
	});
});
