// The skip test's oracle (slice 14 §3.3, test 13a): in randomized runs of writes over own, joined and `exists`
// tables, with reads of every shape the slice's screens use, every read's adopted result equals a fresh run of its
// statement after every commit, whether the commit ran it again or skipped it. And the deterministic cases of the
// rule's table: what skips without a probe, what a probe decides, what always runs.

import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../src/context/index.ts";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { bool, int, opt, str } from "../../src/contracts/index.ts";
import { Batch } from "../../src/state/internal.ts";
import { defineColumns } from "../../src/store/column-set.ts";
import {
	and,
	compile,
	eq,
	exists,
	existsNode,
	inArray,
	isNull,
	not,
	or,
	type WhereNode,
} from "../../src/store/expression.ts";
import { OpenQuery, type OpenRead } from "../../src/store/open-query.ts";
import { type Query, query } from "../../src/store/query.ts";
import type { ReadKind, ReadRun } from "../../src/store/read.ts";
import { ReadRefresh } from "../../src/store/reads.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable, type TableDefinition } from "../../src/store/table.ts";
import { TableChanges } from "../../src/store/table-changes.ts";
import type { TableHandle } from "../../src/store/table-handle.ts";
import { memoryStore, metered, tableIn } from "../support.ts";

const SessionColumns = defineColumns("sessions.columns", {
	columns: {
		id: str(),
		app: str(),
		creator: str(),
		private: bool(),
		state: str(),
		lastTouch: int(),
		archivedAt: opt(int()),
	},
	key: ["id"],
});
const Sessions = defineTable("sessions", {
	version: 1,
	columns: { ...SessionColumns.columns, title: str() },
	key: ["id"],
	indexes: {
		by_app: ["app", "lastTouch"],
		by_state: ["state", "lastTouch"],
		by_creator: ["app", "creator", "lastTouch"],
	},
	exposes: SessionColumns,
});
const TeamSessions = defineColumns("club.team-sessions", {
	columns: { team: str(), session: str() },
	key: ["team", "session"],
	indexes: { ofSession: ["session"] },
});
const Teams = defineTable("teams", {
	version: 1,
	columns: { ...TeamSessions.columns },
	key: ["team", "session"],
	indexes: { of_session: ["session"] },
	exposes: TeamSessions,
});
const ShareColumns = defineColumns("people.shares", {
	columns: { person: str(), session: str() },
	key: ["person", "session"],
	indexes: { ofSession: ["session"] },
});
const Shares = defineTable("shares", {
	version: 1,
	columns: { ...ShareColumns.columns },
	key: ["person", "session"],
	indexes: { of_session: ["session"] },
	exposes: ShareColumns,
});
// A pin's session is no key column: an `update` or a replacing `put` re-points it.
const PinColumns = defineColumns("pins.columns", {
	columns: { id: int(), person: str(), session: str() },
	key: ["id"],
	indexes: { ofSession: ["session"] },
});
const Pins = defineTable("pins", {
	version: 1,
	columns: { ...PinColumns.columns, at: int() },
	key: ["id"],
	indexes: { of_session: ["session"] },
	exposes: PinColumns,
});
const Notes = defineTable("notes", {
	version: 1,
	columns: { id: int(), person: str(), session: opt(str()), at: int() },
	key: ["id"],
	indexes: { of_person: ["person", "at"] },
});

const SESSIONS = Array.from({ length: 24 }, (_, index) => `s${String(index).padStart(2, "0")}`);
const PERSONS = ["anna", "ben", "cleo"];
const TEAMS = ["u10", "u12", "u14"];
const APPS = ["club", "family"];
const STATES = ["working", "waiting", "idle"];

/** What a person may see: the family's public sessions and their own, the club's by team, and what is shared. */
function conditionOf(person: string, teams: readonly string[]): WhereNode {
	const s = SessionColumns.refs;
	return compile(
		SessionColumns,
		or(
			and(eq(s.app, "family"), or(eq(s.private, false), eq(s.creator, person))),
			and(
				eq(s.app, "club"),
				exists(TeamSessions, { session: s.id }, (t) => inArray(t.team, teams)),
			),
			and(
				inArray(s.app, APPS),
				exists(ShareColumns, { session: s.id }, (x) => eq(x.person, person)),
			),
		),
	);
}

/** The reads of the slice's screens (§8), by name: each a query and how much of it is read. */
function shapes(): {
	readonly name: string;
	readonly query: Query;
	readonly table: TableDefinition;
	readonly what: ReadKind;
}[] {
	const anna = conditionOf("anna", ["u10", "u12"]);
	const ben = conditionOf("ben", ["u14"]);
	const first = (limit: number): ReadKind => ({ kind: "rows", range: { limit } });
	const visible = (app: string, condition: WhereNode) =>
		query(Sessions)
			.where((s) => eq(s.app, app))
			.whereNode(SessionColumns, condition)
			.orderBy((s) => s.lastTouch, "desc")
			.orderBy((s) => s.id, "desc");
	const ofTeams = (teams: readonly string[], condition: WhereNode) =>
		query(Teams)
			.where((t) => inArray(t.team, teams))
			.join(SessionColumns, (t) => ({ id: t.session }))
			.where((_t, session) => and(eq(session.app, "club"), isNull(session.archivedAt)))
			.whereNode(SessionColumns, condition)
			.orderBy((_t, session) => session.lastTouch, "desc")
			.orderBy((_t, session) => session.id, "desc");
	const all = query(Sessions).orderBy((s) => s.lastTouch, "desc");
	return [
		{ name: "visible club, anna", query: visible("club", anna), table: Sessions, what: first(4) },
		{ name: "visible family, ben", query: visible("family", ben), table: Sessions, what: first(3) },
		{
			name: "one",
			query: query(Sessions)
				.where((s) => eq(s.id, "s03"))
				.whereNode(SessionColumns, anna),
			table: Sessions,
			what: first(1),
		},
		{ name: "team page u12", query: ofTeams(["u12"], anna), table: Teams, what: first(3) },
		{ name: "club list, two teams", query: ofTeams(["u10", "u12"], anna), table: Teams, what: first(5) },
		{ name: "team count", query: ofTeams(["u14"], ben), table: Teams, what: { kind: "count" } },
		{
			name: "shared with ben",
			query: query(Shares)
				.where((x) => eq(x.person, "ben"))
				.join(SessionColumns, (x) => ({ id: x.session }))
				.whereNode(SessionColumns, ben)
				.orderBy((_x, session) => session.lastTouch, "desc"),
			table: Shares,
			what: first(3),
		},
		{
			name: "created by anna",
			query: query(Sessions)
				.where((s) => and(eq(s.app, "club"), eq(s.creator, "anna")))
				.orderBy((s) => s.lastTouch, "desc"),
			table: Sessions,
			what: first(3),
		},
		{
			name: "active",
			query: query(Sessions)
				.where((s) => inArray(s.state, ["working", "waiting"]))
				.whereNode(SessionColumns, anna)
				.orderBy((s) => s.state, "desc")
				.orderBy((s) => s.lastTouch, "desc"),
			table: Sessions,
			what: first(4),
		},
		{
			name: "pinned by anyone",
			query: query(Sessions)
				.where((s) => exists(PinColumns, { session: s.id }))
				.orderBy((s) => s.lastTouch, "desc"),
			table: Sessions,
			what: first(4),
		},
		{
			name: "pinned by nobody",
			query: query(Sessions).where((s) => and(eq(s.app, "family"), not(exists(PinColumns, { session: s.id })))),
			table: Sessions,
			what: first(4),
		},
		{
			name: "shared with nobody",
			query: query(Sessions)
				.where((s) => and(eq(s.app, "family"), not(exists(ShareColumns, { session: s.id }))))
				.orderBy((s) => s.lastTouch, "desc"),
			table: Sessions,
			what: first(3),
		},
		{
			name: "anna's pins",
			query: query(Pins)
				.where((p) => eq(p.person, "anna"))
				.join(SessionColumns, (p) => ({ id: p.session }))
				.whereNode(SessionColumns, anna)
				.orderBy((p) => p.at, "desc"),
			table: Pins,
			what: first(3),
		},
		{
			name: "anna's notes",
			query: query(Notes)
				.where((n) =>
					and(eq(n.person, "anna"), or(isNull(n.session), existsNode(SessionColumns, { id: n.session }, anna))),
				)
				.orderBy((n) => n.at, "desc"),
			table: Notes,
			what: first(4),
		},
		{
			name: "a page",
			query: all,
			table: Sessions,
			what: { kind: "rows", range: { after: [5000, "s20"], through: [2000, "s02"], limit: 6 } },
		},
		{
			name: "an open page",
			query: all,
			table: Sessions,
			what: { kind: "rows", range: { after: [3000, "s10"], limit: 5 } },
		},
		{
			name: "all sessions count",
			query: query(Sessions).where((s) => eq(s.app, "club")),
			table: Sessions,
			what: { kind: "count" },
		},
	];
}

/** A small deterministic generator (mulberry32): a failing seed reproduces. */
function random(seed: number): {
	pick<T>(items: readonly T[]): T;
	int(below: number): number;
	chance(p: number): boolean;
} {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		pick: (items) => items[Math.floor(next() * items.length)]!,
		int: (below) => Math.floor(next() * below),
		chance: (p) => next() < p,
	};
}

/** The tables of one store, their sets bound, and the open reads with the run each adopted last. */
type World = {
	readonly store: ChordStore;
	readonly handles: { readonly [name: string]: TableHandle };
	readonly reads: {
		readonly name: string;
		readonly query: OpenQuery;
		readonly open: OpenRead;
		latest: ReadRun | undefined;
	}[];
	readonly batch: Batch;
};

let world: World | undefined;
afterEach(async () => {
	for (const { query } of world?.reads ?? []) query.close();
	await world?.store.close(BACKGROUND_CONTEXT);
	world = undefined;
});

async function opened(context: Context, only?: readonly string[]): Promise<World> {
	const store = await memoryStore();
	const handles: { [name: string]: TableHandle } = {};
	const owner = {};
	for (const definition of [Sessions, Teams, Shares, Pins, Notes]) {
		const handle = await tableIn(store, definition);
		handles[definition.name] = handle;
		if (definition.exposes !== undefined)
			store.reads.bind(definition.exposes.name, { table: handle.sql.table, definition }, owner);
	}
	const batch = new Batch(() => {}, undefined);
	const reads: World["reads"] = [];
	for (const { name, query: q, table, what } of shapes()) {
		if (only !== undefined && !only.includes(name)) continue;
		const spec = { query: q, table: handles[table.name]!.sql.table, projection: {}, owner };
		const opened = new OpenQuery({ store, batch }, spec, what.kind, () => {}, context);
		const entry: { latest: ReadRun | undefined } = { latest: undefined };
		const adopt = (run: ReadRun): void => {
			entry.latest = run;
		};
		const open = opened.read(what, { adopt });
		// The sink writes through `entry`: the listed object is that one.
		reads.push(Object.assign(entry, { name, query: opened, open }));
		await open.load();
	}
	world = { store, handles, reads, batch };
	return world;
}

/** Stages `write`'s table writes as one commit with the refresh a transaction stages, and resolves once adopted. */
function commit(
	w: World,
	context: Context,
	write: (changes: (table: TableDefinition) => TableChanges) => void,
): Promise<number> {
	const staged: StagedWrite[] = [];
	const byTable = new Map<TableDefinition, TableChanges>();
	const changes = (table: TableDefinition): TableChanges => {
		let found = byTable.get(table);
		if (found === undefined) {
			found = new TableChanges(w.handles[table.name]!, staged);
			byTable.set(table, found);
		}
		return found;
	};
	write(changes);
	const written = [...byTable.values()];
	const refresh = new ReadRefresh(
		w.store.reads,
		written.map((each) => each.handle.sql.table),
		() => written.flatMap((each) => each.changes()),
		context,
	);
	staged.push(refresh.write);
	return w.store.commit(
		staged,
		{ admit: () => true, adopt: () => w.batch.commit(() => refresh.adopt(), context) },
		context,
	);
}

/** What a run shows: its rows and `more`, or its count. */
function shown(run: ReadRun | undefined): unknown {
	if (run === undefined) return "no run";
	if (run.kind === "rows") return { rows: run.result.rows, more: run.result.more };
	return run.kind === "count" ? run.count : `failed: ${String(run.error)}`;
}

/** Compares every read's adopted run with a fresh run of its statement. */
async function expectFresh(w: World, context: Context, step: string): Promise<void> {
	for (const { name, open, latest } of w.reads) {
		const fresh = await w.store.read((executor) => open.read!.fetch(executor, context), context);
		expect(shown(latest), `${step}: ${name}`).toEqual(shown(fresh));
	}
}

/** One random write to one random table. */
function randomWrite(
	r: ReturnType<typeof random>,
	changes: (table: TableDefinition) => TableChanges,
	clock: number,
): void {
	const session = r.pick(SESSIONS);
	const kind = r.int(12);
	if (kind < 3) {
		// A touch: the write of the slice's mix.
		changes(Sessions).update({ id: session }, { lastTouch: clock, state: r.pick(STATES) });
	} else if (kind === 3) {
		changes(Sessions).put({
			id: session,
			app: r.pick(APPS),
			creator: r.pick(PERSONS),
			private: r.chance(0.3),
			state: r.pick(STATES),
			lastTouch: r.chance(0.5) ? clock : r.int(6000),
			title: `t${clock}`,
			...(r.chance(0.2) ? { archivedAt: clock } : {}),
		});
	} else if (kind === 4) {
		const set = r.pick([
			{ title: `renamed ${clock}` },
			{ app: r.pick(APPS) },
			{ private: r.chance(0.5) },
			{ archivedAt: r.chance(0.5) ? clock : undefined },
			{ creator: r.pick(PERSONS) },
		]);
		changes(Sessions).update({ id: session }, set);
	} else if (kind === 5) {
		if (r.chance(0.3)) changes(Sessions).delete({ id: session });
		else changes(Teams).delete({ team: r.pick(TEAMS), session });
	} else if (kind === 6) changes(Teams).put({ team: r.pick(TEAMS), session });
	else if (kind === 7) {
		if (r.chance(0.6)) changes(Shares).put({ person: r.pick(PERSONS), session });
		else changes(Shares).delete({ person: r.pick(PERSONS), session });
	} else if (kind === 8) {
		const id = r.int(6);
		const choice = r.int(4);
		if (choice === 0) changes(Pins).put({ id, person: r.pick(PERSONS), session, at: clock });
		else if (choice === 1) changes(Pins).update({ id }, { session });
		else if (choice === 2) changes(Pins).update({ id }, { at: clock });
		else changes(Pins).delete({ id });
	} else if (kind === 9) {
		const id = r.int(8);
		if (r.chance(0.7))
			changes(Notes).put({ id, person: r.pick(PERSONS), at: clock, ...(r.chance(0.7) ? { session } : {}) });
		else changes(Notes).delete({ id });
	} else if (kind === 10) {
		changes(Sessions).updateWhere(
			(s: typeof Sessions.refs) => eq(s.app as never, r.pick(APPS)),
			r.chance(0.5) ? { title: "bulk" } : { state: r.pick(STATES) },
		);
	} else changes(Teams).deleteWhere((t: typeof Teams.refs) => eq(t.team as never, r.pick(TEAMS)));
}

describe("the oracle: a skipped read equals a fresh run", () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`randomized writes, single and grouped commits (seed ${seed})`, async () => {
			const meter = await metered();
			const w = await opened(meter.context);
			const r = random(seed);
			let clock = 6000;
			// Seed data, so reads have rows from the start.
			await commit(w, meter.context, (changes) => {
				for (let index = 0; index < 60; index++) randomWrite(r, changes, clock++);
			});
			await expectFresh(w, meter.context, "seeded");
			for (let step = 0; step < 150; step++) {
				// One commit of one to three writes, or a group of commits queued together (one backend transaction).
				const commits = r.chance(0.25) ? 1 + r.int(3) : 1;
				const pending: Promise<number>[] = [];
				for (let index = 0; index < commits; index++) {
					pending.push(
						commit(w, meter.context, (changes) => {
							for (let write = 1 + r.int(2); write > 0; write--) randomWrite(r, changes, clock++);
						}),
					);
				}
				await Promise.all(pending);
				await expectFresh(w, meter.context, `seed ${seed}, step ${step}`);
			}
			const counts = meter.counts();
			// The run exercised all three outcomes.
			expect(counts["chord.query.skips"]).toBeGreaterThan(200);
			expect(counts["chord.query.probes"]).toBeGreaterThan(100);
			expect(counts["chord.query.runs"]).toBeGreaterThan(100);
		});
	}
});

/** Seeds a world with the listed reads and resolves with a function measuring one commit's runs, probes and skips. */
async function measured(only: readonly string[], seed: (changes: (table: TableDefinition) => TableChanges) => void) {
	const meter = await metered();
	const w = await opened(meter.context, only);
	await commit(w, meter.context, seed);
	const cost = async (write: (changes: (table: TableDefinition) => TableChanges) => void) => {
		const before = meter.counts();
		await commit(w, meter.context, write);
		await expectFresh(w, BACKGROUND_CONTEXT, "after the write");
		const after = meter.counts();
		const of = (name: string): number => (after[name] ?? 0) - (before[name] ?? 0);
		return { runs: of("chord.query.runs"), probes: of("chord.query.probes"), skips: of("chord.query.skips") };
	};
	return { w, cost };
}

const session = (
	id: string,
	fields: Partial<{ app: string; creator: string; lastTouch: number; state: string }> = {},
) => ({
	id,
	app: "club",
	creator: "anna",
	private: false,
	state: "idle",
	lastTouch: 100,
	title: id,
	...fields,
});

describe("own table", () => {
	it("an update of a column the read does not depend on skips without a probe; a touch of another row probes", async () => {
		const { cost } = await measured(["created by anna"], (changes) => {
			for (const [index, id] of ["s01", "s02", "s03", "s04", "s05"].entries())
				changes(Sessions).put(session(id, { lastTouch: 100 + index }));
			changes(Sessions).put(session("s06", { creator: "ben", lastTouch: 50 }));
		});
		// The window holds s05, s04, s03 and, past its bound, s02.
		expect(await cost((changes) => changes(Sessions).update({ id: "s01" }, { title: "renamed" }))).toEqual({
			runs: 0,
			probes: 0,
			skips: 1,
		});
		// A row in the window: its mapped column changed.
		expect(await cost((changes) => changes(Sessions).update({ id: "s04" }, { title: "renamed" }))).toEqual({
			runs: 1,
			probes: 0,
			skips: 0,
		});
		// Ben's session touched: an order column, so it might enter; the probe says it does not.
		expect(await cost((changes) => changes(Sessions).update({ id: "s06" }, { lastTouch: 999 }))).toEqual({
			runs: 0,
			probes: 1,
			skips: 1,
		});
		// A row past the window touched to the top: the probe finds it.
		expect(await cost((changes) => changes(Sessions).update({ id: "s01" }, { lastTouch: 1000 }))).toEqual({
			runs: 1,
			probes: 1,
			skips: 0,
		});
		// A put behind the row past the bound: a probe miss.
		expect(await cost((changes) => changes(Sessions).put(session("s07", { lastTouch: 1 })))).toEqual({
			runs: 0,
			probes: 1,
			skips: 1,
		});
		// A delete of a row that was not fetched needs no probe; of the row past the bound it runs.
		expect(await cost((changes) => changes(Sessions).delete({ id: "s07" }))).toEqual({
			runs: 0,
			probes: 0,
			skips: 1,
		});
		expect(await cost((changes) => changes(Sessions).delete({ id: "s03" }))).toEqual({
			runs: 1,
			probes: 0,
			skips: 0,
		});
	});

	it("a bulk update skips by the columns it assigns; a bulk delete runs; a count skips only by its condition columns", async () => {
		const { cost } = await measured(["created by anna", "all sessions count"], (changes) => {
			changes(Sessions).put(session("s01"));
		});
		// The list maps every column, the count depends on `app` alone.
		expect(
			await cost((changes) =>
				changes(Sessions).updateWhere((s: typeof Sessions.refs) => eq(s.app as never, "club"), { private: true }),
			),
		).toEqual({ runs: 1, probes: 0, skips: 1 });
		// A touch: the list's order column, no condition column of the count.
		expect(await cost((changes) => changes(Sessions).update({ id: "s01" }, { lastTouch: 7 }))).toEqual({
			runs: 1,
			probes: 0,
			skips: 1,
		});
		// A put tells nothing: the count keeps no keys and runs.
		expect((await cost((changes) => changes(Sessions).put(session("s09", { app: "family" })))).runs).toBe(1);
		expect(
			await cost((changes) => changes(Sessions).deleteWhere((s: typeof Sessions.refs) => eq(s.id as never, "s09"))),
		).toEqual({ runs: 2, probes: 0, skips: 0 });
	});
});

describe("a joined table", () => {
	it("the team page of another team is skipped by one probe; the session's team runs", async () => {
		const { cost } = await measured(["team page u12", "club list, two teams"], (changes) => {
			for (const [index, id] of ["s01", "s02", "s03"].entries()) {
				changes(Sessions).put(session(id, { lastTouch: 100 + index }));
				changes(Teams).put({ team: index === 2 ? "u14" : "u12", session: id });
			}
			changes(Sessions).put(session("s04", { lastTouch: 90 }));
		});
		// s03 is in u14 only: both reads ask their probe, and neither runs.
		expect(
			await cost((changes) => changes(Sessions).update({ id: "s03" }, { lastTouch: 999, state: "working" })),
		).toEqual({ runs: 0, probes: 2, skips: 2 });
		// s01 is on both: its partner key is among their rows.
		expect(await cost((changes) => changes(Sessions).update({ id: "s01" }, { lastTouch: 1000 }))).toEqual({
			runs: 2,
			probes: 0,
			skips: 0,
		});
		// A partner column outside condition, order and the mapped ones: nothing to ask. Here every set column is mapped.
		expect(await cost((changes) => changes(Sessions).update({ id: "s03" }, { title: "x" }))).toEqual({
			runs: 0,
			probes: 0,
			skips: 2,
		});
		// A partner that is no row's partner, deleted: it cannot enter.
		expect(await cost((changes) => changes(Sessions).delete({ id: "s03" }))).toEqual({
			runs: 0,
			probes: 0,
			skips: 2,
		});
		// A team row is a write of the own table, and of the table the person's condition tests `exists` in. s04 joins
		// u10: the u12 page asks both probes and skips, the two-team list's first probe finds the row.
		expect(await cost((changes) => changes(Teams).put({ team: "u10", session: "s04" }))).toEqual({
			runs: 1,
			probes: 3,
			skips: 1,
		});
		// s02 is on both pages: another team row of it may change its `exists`, so both run.
		expect((await cost((changes) => changes(Teams).put({ team: "u10", session: "s02" }))).runs).toBe(2);
	});
});

describe("an exists table", () => {
	it("a pin moved from one session to another runs the reads of both, also under not(exists)", async () => {
		const { w, cost } = await measured(["pinned by anyone", "pinned by nobody"], (changes) => {
			for (const id of ["s01", "s02", "s03"]) changes(Sessions).put(session(id, { app: "family" }));
			changes(Pins).put({ id: 1, person: "anna", session: "s01", at: 1 });
		});
		const pinned = (): unknown => shown(w.reads[0]!.latest);
		expect(pinned()).toMatchObject({ rows: [{ id: "s01" }] });
		// The matched column is no key column: what the pin paired with before is unknown, so both reads run.
		expect(await cost((changes) => changes(Pins).update({ id: 1 }, { session: "s02" }))).toEqual({
			runs: 2,
			probes: 0,
			skips: 0,
		});
		expect(pinned()).toMatchObject({ rows: [{ id: "s02" }] });
		expect(await cost((changes) => changes(Pins).put({ id: 1, person: "anna", session: "s03", at: 2 }))).toEqual({
			runs: 2,
			probes: 0,
			skips: 0,
		});
		expect(pinned()).toMatchObject({ rows: [{ id: "s03" }] });
		// A column outside the match and the inner condition: nothing to ask.
		expect(await cost((changes) => changes(Pins).update({ id: 1 }, { at: 3 }))).toEqual({
			runs: 0,
			probes: 0,
			skips: 2,
		});
	});

	it("a share of a session of another app is skipped by one probe; of a row in the read it runs", async () => {
		const { cost } = await measured(["visible club, anna", "one"], (changes) => {
			changes(Sessions).put(session("s01", { app: "family", creator: "ben" }));
			changes(Sessions).put(session("s03"));
			changes(Teams).put({ team: "u10", session: "s03" });
		});
		// s01 is the family's: the club list's probe misses, the read of s03 asks its own and misses too.
		expect(await cost((changes) => changes(Shares).put({ person: "anna", session: "s01" }))).toEqual({
			runs: 0,
			probes: 2,
			skips: 2,
		});
		// s03 is in both reads: a share of it may change them.
		expect(await cost((changes) => changes(Shares).put({ person: "ben", session: "s03" }))).toEqual({
			runs: 2,
			probes: 0,
			skips: 0,
		});
	});
});

describe("cost (code review round 1)", () => {
	it("a transaction writing many rows asks a read a few probes, then runs it", async () => {
		// Fable S5: a bulk of puts must not probe one read once per row.
		const { cost } = await measured(["created by anna"], (changes) => {
			changes(Sessions).put(session("s01"));
		});
		const bulk = await cost((changes) => {
			for (let index = 0; index < 100; index++) changes(Sessions).put(session(`b${index}`, { creator: "ben" }));
		});
		expect(bulk).toEqual({ runs: 1, probes: 8, skips: 0 });
	});

	it("builds no change of a transaction whose tables nothing reads", async () => {
		// Fable S4, Opus: a store without reads pays its writes nothing for them.
		const meter = await metered();
		const w = await opened(meter.context, []);
		let built = 0;
		const staged: StagedWrite[] = [];
		const changes = new TableChanges(w.handles[Sessions.name]!, staged);
		changes.put(session("s01"));
		const refresh = new ReadRefresh(
			w.store.reads,
			[changes.handle.sql.table],
			() => {
				built++;
				return changes.changes();
			},
			meter.context,
		);
		staged.push(refresh.write);
		await w.store.commit(staged, { admit: () => true, adopt: () => refresh.adopt() }, meter.context);
		expect(built).toBe(0);
	});
});
