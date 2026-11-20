// A list's pages under several owners (slice 14 §4, test list `host/list` "commit groups", code review round 1):
// a team's sessions, driven from the club's team rows and joined with the sessions' rows, so two owners' commits
// reach one page. The runs of one commit, and of a commit group, are all computed before any is adopted: a run of a
// page an earlier adoption cut or merged applies to the pages that cover its interval, which then know its keys and
// whether it was cut. After every adoption of randomized runs the value is a gapless prefix of the true order,
// compared row by row.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, int, local, method, obj, opt, queries, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { defineColumns } from "../../src/store/column-set.ts";
import { add, eq, exists } from "../../src/store/expression.ts";
import { query } from "../../src/store/query.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { evolveTable } from "../../src/store/table-evolve.ts";
import { changesOf, delivered, flushed, memoryStore } from "../support.ts";

const SessionColumns = defineColumns("sessions.columns", {
	columns: { id: str(), title: str(), touched: int() },
	key: ["id"],
});
const SessionRows = defineTable("session-rows", {
	version: 1,
	columns: { ...SessionColumns.columns },
	key: ["id"],
	exposes: SessionColumns,
});
const Session = obj({ id: str(), title: str(), touched: int() });
/** One transaction of the sessions' owner: rows put, touched, renamed and dropped. */
const SessionWrites = obj({
	put: opt(arr(Session)),
	touch: opt(arr(obj({ id: str(), touched: int() }))),
	rename: opt(arr(obj({ id: str(), title: str() }))),
	drop: opt(arr(str())),
	/** Adds past the integer range: refused in the commit step (the column's check), not at staging. */
	overflow: opt(arr(str())),
});
const Sessions = local("app.sessions", { version: 1, params: {}, members: { write: method(SessionWrites) } });

const TeamRows = defineTable("team-rows", {
	version: 1,
	columns: { team: str(), session: str() },
	key: ["team", "session"],
});
const Membership = obj({ team: str(), session: str() });
const Club = local("app.club", {
	version: 1,
	params: {},
	members: {
		teams: queries(Session, { ofTeam: obj({ team: str() }) }),
		write: method(obj({ add: opt(arr(Membership)), remove: opt(arr(Membership)) })),
	},
});
const FillRows = defineTable("fill-rows", { version: 1, columns: { id: int() }, key: ["id"] });
/** A third owner: its commit runs first, so the two that queue behind it form one group. */
const Filler = local("app.filler", { version: 1, params: {}, members: { write: method(int()) } });
const Screen = local("app.screen", {
	version: 1,
	params: { view: str() },
	members: { list: obj({ rows: arr(Session), moreAfter: bool() }), more: method(), show: method(str()) },
});

type Row = { id: string; title: string; touched: number };
/** What the store's wrapper does around every commit's adoption: `before` applies what the commit wrote to the truth. */
type Probe = { pending: (() => void)[]; adopted(): void };

function facetOf(first: number) {
	return defineFacet((h) => {
		h.serve(Sessions, (_, self) => {
			const rows = self.table(SessionRows);
			return {
				write: async ({ put = [], touch = [], rename = [], drop = [], overflow = [] }, ctx) => {
					await self.tx(async (tx) => {
						for (const id of overflow) {
							tx.update(rows, { id }, (r) => ({ touched: add(r.touched, Number.MAX_SAFE_INTEGER) }));
						}
						for (const row of put) tx.put(rows, row);
						for (const { id, touched } of touch) tx.update(rows, { id }, { touched });
						for (const { id, title } of rename) tx.update(rows, { id }, { title });
						for (const id of drop) tx.delete(rows, { id });
					}, ctx);
					return null;
				},
			};
		});
		h.serve(Club, (_, self) => {
			const rows = self.table(TeamRows);
			return {
				teams: self.queries(
					rows,
					{
						map: (_row, session) => ({
							id: session.id as string,
							title: session.title as string,
							touched: session.touched as number,
						}),
						reads: [],
					},
					{
						// The key (team, session): driven from the team's rows, ordered by the sessions' last touch.
						ofTeam: ({ team }: { team: string }) => {
							if (team === "broken") throw new Error("no such team");
							return query(TeamRows)
								.where((t) => eq(t.team, team))
								.join(SessionColumns, (t) => ({ id: t.session }))
								.orderBy((_t, session) => session.touched, "desc");
						},
					},
				),
				write: async ({ add = [], remove = [] }, ctx) => {
					await self.tx(async (tx) => {
						for (const row of remove) tx.delete(rows, row);
						for (const row of add) tx.put(rows, row);
					}, ctx);
					return null;
				},
			};
		});
		h.serve(Filler, (_, self) => {
			const rows = self.table(FillRows);
			return {
				write: async (id, ctx) => {
					await self.tx(async (tx) => tx.put(rows, { id }), ctx);
					return null;
				},
			};
		});
		h.serve(Screen, (_params, self) => {
			const team = self.writable("t");
			const args = self.derive([team], ([shown]) => ({ team: shown }));
			const list = self.list("team", [[self.get(Club, {}).teams.ofTeam, args]], { first });
			return {
				list: list.value,
				more: (ctx) => list.more(ctx),
				show: async (shown) => {
					team.set(shown);
					return null;
				},
			};
		});
	});
}

/**
 * A host with the three owners and a screen of team "t" in pages of `first`; sessions s1 to s`seed`, touched at
 * their number, all in the team. Every commit's adoption is followed by `probe.adopted()`, after the first of
 * `probe.pending` (what that commit wrote) ran.
 */
async function hosted(first: number, seed: number) {
	const store: ChordStore = await memoryStore();
	const host: Host = createHost({ store, onError: () => {} });
	const probe: Probe = { pending: [], adopted: () => {} };
	await host.load([{ name: "@test/team", facet: facetOf(first) }], context);
	const [sessions, club, filler] = [
		await host.get(Sessions, {}, context),
		await host.get(Club, {}, context),
		await host.get(Filler, {}, context),
	];
	const ids = Array.from({ length: seed }, (_, index) => `s${index + 1}`);
	await sessions.write({ put: ids.map((id, index) => ({ id, title: `old ${id}`, touched: index + 1 })) }, context);
	await club.write({ add: ids.map((session) => ({ team: "t", session })) }, context);
	const screen = await host.get(Screen, { view: "v" }, context);
	// From here on: a commit takes what it wrote from `pending` when it is queued, and tells the probe once adopted.
	const commit = store.commit.bind(store);
	let groups = 0;
	let last = store.lastSeq;
	store.onCommitted(
		(seq) => {
			if (seq - last > 1) groups++;
			last = seq;
		},
		() => {},
	);
	store.commit = (writes, fence, ctx) => {
		const wrote = probe.pending.shift();
		const adopt: typeof fence.adopt = (...args) => {
			wrote?.();
			fence.adopt(...args);
			probe.adopted();
		};
		return commit(writes, { ...fence, adopt }, ctx);
	};
	/** Queues the three owners' commits without waiting: the filler's runs alone, the other two as one group. */
	const group = async (first_: () => Promise<unknown>, second: () => Promise<unknown>): Promise<void> => {
		const before = groups;
		await Promise.all([filler.write(1, context), first_(), second()]);
		await flushed();
		expect(groups, "the two commits formed one group").toBe(before + 1);
	};
	const close = async (): Promise<void> => {
		await host.close(context);
		await store.close(context);
	};
	return { store, host, sessions, club, filler, screen, probe, group, grouped: () => groups, close };
}

const shown = (list: { readonly rows: readonly Row[] }): string =>
	list.rows.map((row) => `${row.id}:${row.title}`).join(" ");
const idsOf = (list: { readonly rows: readonly Row[] }): string[] => list.rows.map((row) => row.id);

describe("a commit group of two owners", () => {
	it("a run patched into a merged page: the page knows its rows, so a later rename and delete reach it", async () => {
		// Review round 1 (Fable B1, Opus S2): pages [s5 s4] [s3 s2] [s1].
		const { sessions, club, screen, group, close } = await hosted(2, 5);
		await screen.more(context);
		await screen.more(context);
		expect(idsOf(screen.list.value)).toEqual(["s5", "s4", "s3", "s2", "s1"]);
		// The club removes s3 (its adoption merges the second and third page); the sessions' owner moves s5 to the end
		// (its run for the old third page lands in the merged one).
		await group(
			() => club.write({ remove: [{ team: "t", session: "s3" }] }, context),
			() => sessions.write({ touch: [{ id: "s5", touched: 0 }] }, context),
		);
		expect(idsOf(screen.list.value)).toEqual(["s4", "s2", "s1", "s5"]);
		await sessions.write({ rename: [{ id: "s5", title: "NEW" }] }, context);
		expect(shown(screen.list.value)).toContain("s5:NEW");
		await sessions.write({ drop: ["s5"] }, context);
		expect(idsOf(screen.list.value)).toEqual(["s4", "s2", "s1"]);
		await close();
	});

	it("C1 merges P and Q, C2's run for Q's old interval changes its row and nothing else; then both orders", async () => {
		for (const clubFirst of [true, false]) {
			// Pages P [s6 s5 s4 s3], Q [s2 s1] (first 4): C1 leaves P with [s6] and Q with [s2 s1]; C2 renames s1.
			const { sessions, club, screen, group, close } = await hosted(4, 6);
			await screen.more(context);
			const c1 = () =>
				club.write({ remove: ["s5", "s4", "s3"].map((session) => ({ team: "t", session })) }, context);
			const c2 = () => sessions.write({ rename: [{ id: "s1", title: "renamed" }] }, context);
			await (clubFirst ? group(c1, c2) : group(c2, c1));
			expect(screen.list.value).toEqual({
				rows: [
					{ id: "s6", title: "old s6", touched: 6 },
					{ id: "s2", title: "old s2", touched: 2 },
					{ id: "s1", title: "renamed", touched: 1 },
				],
				moreAfter: false,
			});
			// The merged page is one read that knows all three rows: a touch of each moves it, a delete removes it.
			await sessions.write({ touch: [{ id: "s1", touched: 9 }] }, context);
			await sessions.write({ drop: ["s2"] }, context);
			expect(idsOf(screen.list.value)).toEqual(["s1", "s6"]);
			await close();
		}
	});

	it("a page cut by the first commit's adoption takes the second commit's run for the uncut page", async () => {
		// One page [s3 s2 s1] of first 2 (open, short of a row behind); C1 adds five sessions' team rows (the page is
		// cut), C2 renames s2 (its run read the page as it was before the cut).
		const { sessions, club, screen, group, close } = await hosted(2, 3);
		await screen.more(context);
		expect(idsOf(screen.list.value)).toEqual(["s3", "s2", "s1"]);
		await sessions.write(
			{ put: [4, 5, 6, 7, 8].map((n) => ({ id: `s${n}`, title: `old s${n}`, touched: n })) },
			context,
		);
		await group(
			() => club.write({ add: [4, 5, 6, 7, 8].map((n) => ({ team: "t", session: `s${n}` })) }, context),
			() => sessions.write({ rename: [{ id: "s2", title: "renamed" }] }, context),
		);
		for (let page = 0; page < 6 && screen.list.value.moreAfter; page++) await screen.more(context);
		expect(shown(screen.list.value)).toBe(
			"s8:old s8 s7:old s7 s6:old s6 s5:old s5 s4:old s4 s3:old s3 s2:renamed s1:old s1",
		);
		// Every page knows its rows: each is still reached.
		await sessions.write({ drop: ["s8", "s5", "s2"] }, context);
		expect(idsOf(screen.list.value)).toEqual(["s7", "s6", "s4", "s3", "s1"]);
		await close();
	});

	it("a group that rolled back and ran again alone leaves the same pages", async () => {
		const { sessions, club, screen, filler, close } = await hosted(2, 5);
		await screen.more(context);
		await screen.more(context);
		// The sessions' commit refuses in its step (an integer past its range): the group rolls back, each commit runs
		// again alone, and the club's stands.
		const bad = sessions.write({ overflow: ["s1"] }, context).catch((error: Error) => error);
		await Promise.all([
			filler.write(1, context),
			club.write({ remove: [{ team: "t", session: "s3" }] }, context),
			bad,
		]);
		await flushed();
		expect(idsOf(screen.list.value)).toEqual(["s5", "s4", "s2", "s1"]);
		await sessions.write({ touch: [{ id: "s1", touched: 50 }] }, context);
		expect(idsOf(screen.list.value)).toEqual(["s1", "s5", "s4", "s2"]);
		await close();
	});
});

describe("one commit, several pages", () => {
	it("a merge by the first page's run and the second page's run after it: the merged page knows the new row", async () => {
		// Review round 1 (Astra B1): pages [s6 s5 s4 s3] [s2 s1]; one commit of the club drops four rows and adds s7
		// (touched between s3 and s1).
		const { sessions, club, screen, close } = await hosted(4, 6);
		await screen.more(context);
		await sessions.write({ put: [{ id: "s7", title: "old s7", touched: 2 }] }, context);
		await club.write(
			{
				remove: ["s6", "s5", "s4", "s2"].map((session) => ({ team: "t", session })),
				add: [{ team: "t", session: "s7" }],
			},
			context,
		);
		expect(idsOf(screen.list.value)).toEqual(["s3", "s7", "s1"]);
		await club.write({ remove: [{ team: "t", session: "s7" }] }, context);
		expect(idsOf(screen.list.value)).toEqual(["s3", "s1"]);
		await close();
	});

	it("a cut run patched into a merged page keeps its continuation: more rows are behind, and more loads them", async () => {
		// Review round 1 (Astra B2): the second page's run returns four of ten new rows, cut by its limit; the page
		// merged meanwhile must not claim the list is complete. With rows left in the first page, and with none.
		for (const emptied of [
			["s6", "s5", "s4", "s2"],
			["s6", "s5", "s4", "s3", "s2"],
		]) {
			const { sessions, club, screen, close } = await hosted(4, 6);
			await screen.more(context);
			const added = Array.from({ length: 10 }, (_, index) => `n${index}`);
			await sessions.write({ put: added.map((id) => ({ id, title: id, touched: 2 })) }, context);
			await club.write(
				{
					remove: emptied.map((session) => ({ team: "t", session })),
					add: added.map((session) => ({ team: "t", session })),
				},
				context,
			);
			const all = [...(emptied.includes("s3") ? [] : ["s3"]), ...added.toReversed(), "s1"];
			const { rows, moreAfter } = screen.list.value;
			expect(idsOf({ rows })).toEqual(all.slice(0, rows.length));
			expect(moreAfter || rows.length === all.length).toBe(true);
			for (let page = 0; page < 6 && screen.list.value.moreAfter; page++) await screen.more(context);
			expect(idsOf(screen.list.value)).toEqual(all);
			await close();
		}
	});
});

describe("a row another owner's commit lets in, in the group that merged its pages", () => {
	// Code review round 1 (Sol 7): pages of two; row 35 is hidden by an `exists` in the gates' set. One group: the
	// rows' owner deletes 20 and 40 (the pages merge), the gates' owner lets 35 in (the run for the second page's
	// old interval brings it). The merged page must know 35, or its delete is skipped.
	const GateSet = defineColumns("gate.columns", { columns: { id: int() }, key: ["id"] });
	const Gate = defineTable("gate", { version: 1, columns: { ...GateSet.columns }, key: ["id"], exposes: GateSet });
	const Data = defineTable("data", { version: 1, columns: { id: int() }, key: ["id"] });
	const Item = obj({ id: int() });
	const Rows = local("app.rows", {
		version: 1,
		params: {},
		members: {
			rows: queries(Item, { all: obj({}) }),
			write: method(obj({ put: opt(arr(int())), drop: opt(arr(int())) })),
		},
	});
	const Gates = local("app.gates", { version: 1, params: {}, members: { put: method(arr(int())) } });
	const Gated = local("app.gated", {
		version: 1,
		params: {},
		members: { list: obj({ rows: arr(Item), moreAfter: bool() }), more: method() },
	});
	const facet = defineFacet((h) => {
		h.serve(Rows, (_, self) => {
			const table = self.table(Data);
			return {
				rows: self.queries(
					table,
					{ map: (row) => ({ id: row.id }) },
					{ all: (_args: Record<string, never>) => query(Data).where((r) => exists(GateSet, { id: r.id })) },
				),
				write: async ({ put = [], drop = [] }, ctx) => {
					await self.tx(async (tx) => {
						for (const id of put) tx.put(table, { id });
						for (const id of drop) tx.delete(table, { id });
					}, ctx);
					return null;
				},
			};
		});
		h.serve(Gates, (_, self) => {
			const table = self.table(Gate);
			return {
				put: async (ids, ctx) => {
					await self.tx(async (tx) => {
						for (const id of ids) tx.put(table, { id });
					}, ctx);
					return null;
				},
			};
		});
		h.serve(Filler, (_, self) => {
			const rows = self.table(FillRows);
			return {
				write: async (id, ctx) => {
					await self.tx(async (tx) => tx.put(rows, { id }), ctx);
					return null;
				},
			};
		});
		h.serve(Gated, (_, self) => {
			const list = self.list("rows", [[self.get(Rows, {}).rows.all, {}]], { first: 2 });
			return { list: list.value, more: (ctx) => list.more(ctx) };
		});
	});

	it("is known to the merged page: its delete reaches the list", async () => {
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		await host.load([{ name: "@test/gated", facet }], context);
		const [rows, gates, filler] = [
			await host.get(Rows, {}, context),
			await host.get(Gates, {}, context),
			await host.get(Filler, {}, context),
		];
		await rows.write({ put: [10, 20, 30, 35, 40, 50, 60] }, context);
		await gates.put([10, 20, 30, 40, 50, 60], context);
		const screen = await host.get(Gated, {}, context);
		await screen.more(context);
		const ids = (): number[] => screen.list.value.rows.map((row) => row.id);
		expect(ids()).toEqual([10, 20, 30, 40]);
		// Commits queued behind a running one are one group: one notification for several sequence numbers.
		const before = store.lastSeq;
		const seqs: number[] = [];
		store.onCommitted(
			(seq) => seqs.push(seq),
			() => {},
		);
		await Promise.all([filler.write(1, context), rows.write({ drop: [20, 40] }, context), gates.put([35], context)]);
		await flushed();
		expect(seqs.at(-1), "the three commits").toBe(before + 3);
		expect(seqs.length, "the two commits formed one group").toBeLessThan(3);
		expect(ids()).toEqual([10, 30, 35]);
		await rows.write({ drop: [35] }, context);
		await flushed();
		expect(ids().slice(0, 2)).toEqual([10, 30]);
		expect(ids()).not.toContain(35);
		await host.close(context);
		await store.close(context);
	});
});

describe("a publisher's migration that changes the order (code review round 2, Sol)", () => {
	// The list joins another plugin's set and orders by its `touched`. Only the publisher reloads: its migration
	// turns the order around. The provider and the list's object keep their code and their attempts.
	const Touches = defineColumns("touch.columns", { columns: { id: int(), touched: int() }, key: ["id"] });
	const TouchRows = defineTable("touches", {
		version: 1,
		columns: { ...Touches.columns },
		key: ["id"],
		exposes: Touches,
	});
	const Turned = evolveTable(TouchRows, (t) => t.rows((row) => ({ touched: 10 - row.touched })));
	const Data = defineTable("data", { version: 1, columns: { id: int() }, key: ["id"] });
	const Item = obj({ id: int() });
	const Rows = local("app.rows", {
		version: 1,
		params: {},
		members: { rows: queries(Item, { all: obj({}) }), put: method(int()) },
	});
	const Toucher = local("app.toucher", { version: 1, params: {}, members: { put: method(int()) } });
	const Listed = local("app.listed", {
		version: 1,
		params: {},
		members: { list: obj({ rows: arr(Item), moreAfter: bool() }), more: method() },
	});
	const readers = defineFacet((h) => {
		h.serve(Rows, (_, self) => {
			const table = self.table(Data);
			return {
				rows: self.queries(
					table,
					{ map: (row) => ({ id: row.id }) },
					{
						all: (_args: Record<string, never>) =>
							query(Data)
								.join(Touches, (r) => ({ id: r.id }))
								.orderBy((_r, touch) => touch.touched, "desc"),
					},
				),
				put: async (id, ctx) => {
					await self.tx(async (tx) => tx.put(table, { id }), ctx);
					return null;
				},
			};
		});
		h.serve(Listed, (_, self) => {
			const list = self.list("rows", [[self.get(Rows, {}).rows.all, {}]], { first: 2 });
			return { list: list.value, more: (ctx) => list.more(ctx) };
		});
	});
	const publisher = (table: typeof TouchRows | typeof Turned) => ({
		name: "@test/publisher",
		facet: defineFacet((h) => {
			h.serve(Toucher, (_, self) => {
				const rows = self.table(table);
				return {
					put: async (id, ctx) => {
						await self.tx(async (tx) => tx.put(rows, { id, touched: id }), ctx);
						return null;
					},
				};
			});
		}),
	});

	it("switches the list in one frame: every row once, in the new order, no page reloaded alone", async () => {
		// Each page was loaded again on its own: the first adoption cut and merged the others with the rows they had
		// and closed their loads, and the list ended as [1 2 3 4 5 6 1] for good.
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const plugins = { name: "@test/readers", facet: readers };
		await host.load([plugins, publisher(TouchRows)], context);
		const [rows, toucher] = [await host.get(Rows, {}, context), await host.get(Toucher, {}, context)];
		for (const id of [1, 2, 3, 4, 5, 6]) {
			await rows.put(id, context);
			await toucher.put(id, context);
		}
		const screen = await host.get(Listed, {}, context);
		await screen.more(context);
		await screen.more(context);
		const ids = (list: { readonly rows: readonly { readonly id: number }[] }): number[] =>
			list.rows.map((row) => row.id);
		expect(ids(screen.list.value)).toEqual([6, 5, 4, 3, 2, 1]);
		const watch = await screen.list.watch(context);
		const frames = changesOf(watch);
		await host.reload([plugins, publisher(Turned)], context);
		await flushed();
		await delivered();
		expect(frames.map((frame) => (frame.kind === "value" ? ids(frame.value) : frame.kind))).toEqual([
			[1, 2, 3, 4, 5, 6],
		]);
		expect(screen.list.value.moreAfter).toBe(false);
		// The pages know their rows under the new plan: a write of the publisher still reaches each.
		await toucher.put(3, context);
		await flushed();
		expect(ids(screen.list.value)).toEqual([1, 2, 4, 5, 6, 3]);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});
});

describe("switches and failures", () => {
	it("a switch waits for every page of the new arguments: no page that has not run is shown", async () => {
		// Review round 1 (Sol 5): three pages, the joined table held (its owner migrates it), then other arguments.
		const { club, screen, store, close } = await hosted(2, 6);
		await club.write({ add: ["s1", "s2"].map((session) => ({ team: "u", session })) }, context);
		await screen.more(context);
		await screen.more(context);
		const before = idsOf(screen.list.value);
		expect(before).toHaveLength(6);
		store.reads.hold("app.sessions:session-rows");
		await screen.show("u", context);
		await flushed();
		// The pages of team "u" have not run: the list still shows what it had.
		expect(idsOf(screen.list.value)).toEqual(before);
		store.reads.ready("app.sessions:session-rows");
		await flushed();
		expect(idsOf(screen.list.value)).toEqual(["s2", "s1"]);
		await close();
	});

	it("a more called while a switch is pending waits for it, and loads behind the new arguments' pages", async () => {
		// Code review round 3 (Sol): the new arguments' pages were held, so their start had settled without a run;
		// `more` then loaded behind the old arguments' pages and the page asked for was lost with them.
		const { club, screen, store, close } = await hosted(2, 6);
		await club.write({ add: ["s1", "s2", "s3"].map((session) => ({ team: "u", session })) }, context);
		store.reads.hold("app.sessions:session-rows");
		await screen.show("u", context);
		await flushed();
		let settled = false;
		const more = screen.more(context).then(() => {
			settled = true;
		});
		await delivered();
		expect([settled, idsOf(screen.list.value)]).toEqual([false, ["s6", "s5"]]);
		store.reads.ready("app.sessions:session-rows");
		await more;
		await flushed();
		// The new arguments' rows lie behind the bookmark the list had (s5's position): the switch alone shows none of
		// them, and the page the call asked for is the first that does.
		expect([idsOf(screen.list.value), screen.list.value.moreAfter]).toEqual([["s3", "s2"], true]);
		await close();
	});

	it("a failed page fails the list until that page runs well: another page's run does not heal it", async () => {
		// Review round 1 (Sol 6): three pages; one write renames a session of each, and the first page's run fails.
		const { sessions, screen, store, close } = await hosted(2, 6);
		await screen.more(context);
		await screen.more(context);
		const [first] = [...store.reads.on("app.club:team-rows")!];
		const run = first!.run.bind(first);
		first!.run = async () => ({ kind: "failed", error: new Error("page failure") });
		const rename = (title: string) =>
			sessions.write({ rename: ["s6", "s4", "s2"].map((id) => ({ id, title })) }, context);
		await rename("x");
		expect(() => screen.list.value).toThrow("page failure");
		// A run of the other pages alone changes nothing about that.
		await sessions.write({ rename: [{ id: "s1", title: "y" }] }, context);
		expect(() => screen.list.value).toThrow("page failure");
		first!.run = run;
		await rename("z");
		expect(shown(screen.list.value)).toBe("s6:z s5:old s5 s4:z s3:old s3 s2:z s1:y");
		await close();
	});

	it("a failed page a retired page's later run is patched into stays without a result: the next commit runs it", async () => {
		// Code review round 2 (Astra): pages [s6 s5 s4 s3] and [s2 s1]. One group: C1 removes four sessions from the
		// team (the pages merge; the second page's run fails), C2 renames s1 (the second page's run, for its old
		// interval, succeeds). The merged page is failed, and must not skip the next write as if it knew its rows.
		const { sessions, club, screen, store, group, close } = await hosted(4, 6);
		await screen.more(context);
		const [, tail] = [...store.reads.on("app.club:team-rows")!];
		const run = tail!.run.bind(tail);
		tail!.run = async () => {
			tail!.run = run;
			return { kind: "failed", error: new Error("page failure") };
		};
		await group(
			() => club.write({ remove: ["s6", "s5", "s4", "s2"].map((session) => ({ team: "t", session })) }, context),
			() => sessions.write({ rename: [{ id: "s1", title: "renamed" }] }, context),
		);
		expect(() => screen.list.value).toThrow("page failure");
		// A write that changes no row of the list: a page that knew its rows would ask one probe and skip.
		await sessions.write({ touch: [{ id: "s999", touched: 999 }] }, context);
		expect(shown(screen.list.value)).toBe("s3:old s3 s1:renamed");
		await close();
	});

	it("arguments the builder refuses fail the list; a write to the previous arguments' rows does not publish them", async () => {
		// Review round 1 (Sol 4, for lists).
		const { sessions, screen, close } = await hosted(2, 4);
		await screen.show("broken", context);
		await flushed();
		expect(() => screen.list.value).toThrow("no such team");
		await sessions.write({ rename: [{ id: "s4", title: "edited" }] }, context);
		expect(() => screen.list.value).toThrow("no such team");
		await screen.show("t", context);
		await flushed();
		expect(shown(screen.list.value)).toBe("s4:edited s3:old s3");
		await close();
	});
});

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

describe("the invariant, with two owners and commit groups", () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
		it(`after every adoption the value is a gapless prefix of the true order, row by row (seed ${seed})`, async () => {
			const first = 2 + (seed % 2);
			const { sessions, club, filler, screen, probe, grouped, close } = await hosted(first, 9);
			const r = random(seed);
			const rows = new Map<string, Row>(
				Array.from({ length: 9 }, (_, index) => {
					const id = `s${index + 1}`;
					return [id, { id, title: `old ${id}`, touched: index + 1 }];
				}),
			);
			const team = new Set(rows.keys());
			let clock = 100;
			let made = 9;
			/** The true order: the team's sessions that exist, newest touch first, ties by id (the key's order). */
			const order = (): Row[] =>
				[...team]
					.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []))
					.sort((a, b) => b.touched - a.touched || (a.id < b.id ? 1 : -1));
			let step = "start";
			let checks = 0;
			const check = (): void => {
				const { rows: shownRows, moreAfter } = screen.list.value;
				const expected = order();
				checks++;
				expect(shownRows, `${step}: a prefix`).toEqual(expected.slice(0, shownRows.length));
				if (!moreAfter) expect(shownRows.length, `${step}: the whole order`).toBe(expected.length);
			};
			// After every commit's adoption: the frame it published is checked against the truth as of that commit.
			probe.adopted = check;
			/** A session to write: mostly one the list shows now (a stale page shows there), else any that exists. */
			const pick = (): string => {
				const shownIds = screen.list.value.rows.map((row) => row.id);
				const from = shownIds.length > 0 && r.chance(0.8) ? shownIds : [...rows.keys()];
				return from[r.int(from.length)] ?? "s1";
			};
			/** One owner's commit; what it wrote reaches the truth when its commit is adopted. */
			const sessionsWrite = (): Promise<unknown> => {
				const kind = r.int(8);
				const id = pick();
				if (kind < 2) {
					const touched = r.chance(0.7) ? ++clock : r.int(50);
					probe.pending.push(() => rows.has(id) && rows.set(id, { ...rows.get(id)!, touched }));
					return sessions.write({ touch: [{ id, touched }] }, context);
				}
				if (kind < 5) {
					const title = `t${++clock}`;
					probe.pending.push(() => rows.has(id) && rows.set(id, { ...rows.get(id)!, title }));
					return sessions.write({ rename: [{ id, title }] }, context);
				}
				if (kind < 7) {
					probe.pending.push(() => rows.delete(id));
					return sessions.write({ drop: [id] }, context);
				}
				const fresh = Array.from({ length: 1 + r.int(4 * first) }, () => {
					const row = { id: `s${++made}`, title: `new ${made}`, touched: r.chance(0.5) ? ++clock : r.int(50) };
					return row;
				});
				probe.pending.push(() => {
					for (const row of fresh) rows.set(row.id, row);
				});
				return sessions.write({ put: fresh }, context);
			};
			const clubWrite = (): Promise<unknown> => {
				// Sessions leave the team (mostly shown ones: pages empty and merge) and others join, also many at once
				// (a run cut by its limit) and ones that do not exist yet; often both in one commit.
				const leaving = r.chance(0.6) ? Array.from({ length: 1 + r.int(3) }, pick) : [];
				const joining =
					leaving.length === 0 || r.chance(0.5)
						? Array.from({ length: 1 + r.int(4 * first) }, () => `s${1 + r.int(made + 2)}`)
						: [];
				probe.pending.push(() => {
					for (const session of leaving) team.delete(session);
					for (const session of joining) team.add(session);
				});
				const membership = (session: string) => ({ team: "t", session });
				// The transaction removes, then adds: a session in both stays in the team.
				return club.write({ remove: leaving.map(membership), add: joining.map(membership) }, context);
			};
			for (let index = 0; index < 400; index++) {
				step = `seed ${seed}, step ${index}`;
				const kind = r.int(10);
				if (kind < 3) {
					// A real group: the filler's commit runs alone, the two owners' commits behind it in one transaction.
					probe.pending.push(() => {});
					const fill = filler.write(index, context);
					const [a, b] = r.chance(0.5) ? [sessionsWrite(), clubWrite()] : [clubWrite(), sessionsWrite()];
					await Promise.all([fill, a, b]);
				} else if (kind < 6) await sessionsWrite();
				else if (kind < 9) await clubWrite();
				else await screen.more(context);
				await flushed();
				check();
			}
			expect(grouped()).toBeGreaterThan(50);
			expect(checks).toBeGreaterThan(600);
			for (let page = 0; page < 200 && screen.list.value.moreAfter; page++) await screen.more(context);
			expect(screen.list.value.rows).toEqual(order());
			await close();
		});
	}
});
