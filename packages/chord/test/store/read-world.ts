// The world of the store's read oracles (slice 14 §3.3, slice 15 §3): tables of the slice's screens (own, joined and
// `exists` ones), the reads those screens open, random writes over them, and the check that every read's adopted run
// equals a fresh run of its statement. `skip.test.ts` and `read-index.test.ts` run it.

import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";
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
import { memoryStore, tableIn } from "../support.ts";

export const SessionColumns = defineColumns("sessions.columns", {
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
export const Sessions = defineTable("sessions", {
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
export const TeamSessions = defineColumns("club.team-sessions", {
	columns: { team: str(), session: str() },
	key: ["team", "session"],
	indexes: { ofSession: ["session"] },
});
export const Teams = defineTable("teams", {
	version: 1,
	columns: { ...TeamSessions.columns },
	key: ["team", "session"],
	indexes: { of_session: ["session"] },
	exposes: TeamSessions,
});
export const ShareColumns = defineColumns("people.shares", {
	columns: { person: str(), session: str() },
	key: ["person", "session"],
	indexes: { ofSession: ["session"] },
});
export const Shares = defineTable("shares", {
	version: 1,
	columns: { ...ShareColumns.columns },
	key: ["person", "session"],
	indexes: { of_session: ["session"] },
	exposes: ShareColumns,
});
// A pin's session is no key column: an `update` or a replacing `put` re-points it.
export const PinColumns = defineColumns("pins.columns", {
	columns: { id: int(), person: str(), session: str() },
	key: ["id"],
	indexes: { ofSession: ["session"] },
});
export const Pins = defineTable("pins", {
	version: 1,
	columns: { ...PinColumns.columns, at: int() },
	key: ["id"],
	indexes: { of_session: ["session"] },
	exposes: PinColumns,
});
export const Notes = defineTable("notes", {
	version: 1,
	columns: { id: int(), person: str(), session: opt(str()), at: int() },
	key: ["id"],
	indexes: { of_person: ["person", "at"] },
});

const SESSIONS = Array.from({ length: 24 }, (_, index) => `s${String(index).padStart(2, "0")}`);
export const PERSONS = ["anna", "ben", "cleo"];
export const TEAMS = ["u10", "u12", "u14"];
export const APPS = ["club", "family"];
export const STATES = ["working", "waiting", "idle"];

/** What a person may see: the family's public sessions and their own, the club's by team, and what is shared. */
export function conditionOf(person: string, teams: readonly string[]): WhereNode {
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

/** A read of the world: its name, query, table and what of it is read. */
export type Shape = {
	readonly name: string;
	readonly query: Query;
	readonly table: TableDefinition;
	readonly what: ReadKind;
};

/** The reads of the slice's screens (slice 14 §8), by name: each a query and how much of it is read. */
export function shapes(): Shape[] {
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
			// Two `in` lists: one bucket entry per combination (slice 15 §3).
			name: "club and family by anna and ben",
			query: query(Sessions)
				.where((s) => and(inArray(s.app, APPS), inArray(s.creator, ["anna", "ben"])))
				.orderBy((s) => s.lastTouch, "desc"),
			table: Sessions,
			what: first(5),
		},
		{
			// An `in` of more values than a bucket takes: unindexed, a candidate of every write.
			name: "many states",
			query: query(Sessions)
				.where((s) => inArray(s.state, [...STATES, ...Array.from({ length: 40 }, (_, index) => `x${index}`)]))
				.orderBy((s) => s.lastTouch, "desc"),
			table: Sessions,
			what: first(4),
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
export function random(seed: number): {
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
export type World = {
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

/** Closes the world `opened` made last: its reads and its store. A test file's `afterEach`. */
export async function closeWorld(): Promise<void> {
	for (const { query } of world?.reads ?? []) query.close();
	await world?.store.close(BACKGROUND_CONTEXT);
	world = undefined;
}

/** A store with the tables, their sets bound, and the reads of `shapes()` (those named in `only`), each loaded. */
export async function opened(context: Context, only?: readonly string[]): Promise<World> {
	const store = await memoryStore();
	const handles: { [name: string]: TableHandle } = {};
	for (const definition of [Sessions, Teams, Shares, Pins, Notes]) {
		const handle = await tableIn(store, definition);
		handles[definition.name] = handle;
		if (definition.exposes !== undefined)
			store.reads.bind(definition.exposes.name, { table: handle.sql.table, definition }, OWNER);
	}
	world = { store, handles, reads: [], batch: new Batch(() => {}, undefined) };
	for (const shape of shapes())
		if (only === undefined || only.includes(shape.name)) await openRead(world, shape, context);
	return world;
}

/** The owner of every query of a world. */
const OWNER = {};

/** Opens one more read of `w` and loads it: a list whose arguments changed reads a new query. */
export async function openRead(w: World, shape: Shape, context: Context): Promise<World["reads"][number]> {
	const { name, query: q, table, what } = shape;
	const spec = { query: q, table: w.handles[table.name]!.sql.table, projection: {}, owner: OWNER };
	const opened = new OpenQuery({ store: w.store, batch: w.batch }, spec, what.kind, () => {}, context);
	const entry: { latest: ReadRun | undefined } = { latest: undefined };
	const adopt = (run: ReadRun): void => {
		entry.latest = run;
	};
	const open = opened.read(what, { adopt });
	// The sink writes through `entry`: the listed object is that one.
	const read = Object.assign(entry, { name, query: opened, open });
	w.reads.push(read);
	await open.load();
	return read;
}

/** Stages `write`'s table writes as one commit with the refresh a transaction stages, and resolves once adopted. */
export function commit(
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
export function shown(run: ReadRun | undefined): unknown {
	if (run === undefined) return "no run";
	if (run.kind === "rows") return { rows: run.result.rows, more: run.result.more };
	return run.kind === "count" ? run.count : `failed: ${String(run.error)}`;
}

/** Compares every read's adopted run with a fresh run of its statement. */
export async function expectFresh(w: World, context: Context, step: string): Promise<void> {
	for (const { name, open, latest } of w.reads) {
		const fresh = await w.store.read((executor) => open.read!.fetch(executor, context), context);
		expect(shown(latest), `${step}: ${name}`).toEqual(shown(fresh));
	}
}

/** The names of the reads whose adopted run differs from a fresh run of their statement (none: all are current). */
export async function staleReads(w: World, context: Context): Promise<string[]> {
	const stale: string[] = [];
	for (const { name, open, latest } of w.reads) {
		const fresh = await w.store.read((executor) => open.read!.fetch(executor, context), context);
		if (!isDeepStrictEqual(shown(latest), shown(fresh))) stale.push(name);
	}
	return stale;
}

/** One random write to one random table. */
export function randomWrite(
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
