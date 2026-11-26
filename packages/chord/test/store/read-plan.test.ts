// Read plans (slice 14 §3.3, §5, §6): `exists`, `existsNode`, the one-to-one join and conditions as data, compiled
// against the store's bindings and run on SQLite; what a plan refuses before any SQL; the uses it lists for the skip
// test; and the query plans: a joined read is driven from its own table, a probe is a keyed lookup.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { bool, hostKind, int, num, opt, str } from "../../src/contracts/index.ts";
import { Batch } from "../../src/state/internal.ts";
import { defineColumns } from "../../src/store/column-set.ts";
import {
	and,
	checkNode,
	compile,
	eq,
	exists,
	existsNode,
	inArray,
	isNull,
	not,
	or,
	prefix,
	type WhereNode,
} from "../../src/store/expression.ts";
import { host } from "../../src/store/host-column.ts";
import { OpenQuery } from "../../src/store/open-query.ts";
import { type Query, query } from "../../src/store/query.ts";
import type { ReadRun } from "../../src/store/read.ts";
import { type Range, ReadPlan, type ShapeSlot, type StoredRead } from "../../src/store/read-plan.ts";
import { ReadRefresh } from "../../src/store/reads.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable, type TableDefinition } from "../../src/store/table.ts";
import { TableChanges } from "../../src/store/table-changes.ts";
import type { TableHandle } from "../../src/store/table-handle.ts";
import { expectCollected, memoryStore, metered, tableIn } from "../support.ts";

const SessionColumns = defineColumns("sessions.columns", {
	columns: { id: str(), app: str(), private: bool(), lastTouch: int(), archivedAt: opt(int()) },
	key: ["id"],
});
const Sessions = defineTable("sessions", {
	version: 1,
	columns: { ...SessionColumns.columns, title: str() },
	key: ["id"],
	indexes: { by_app: ["app", "lastTouch"] },
	exposes: SessionColumns,
});
const TeamSessions = defineColumns("club.team-sessions", {
	columns: { team: str(), session: str() },
	key: ["team", "session"],
	indexes: { ofSession: ["session"] },
});
const Teams = defineTable("teams", {
	version: 1,
	columns: { ...TeamSessions.columns, note: opt(str()) },
	key: ["team", "session"],
	indexes: { of_session: ["session"] },
	exposes: TeamSessions,
});
const Notes = defineTable("notes", {
	version: 1,
	columns: { id: int(), session: opt(str()), n: int() },
	key: ["id"],
});

let store: ChordStore;
afterEach(async () => {
	await store?.close(context);
});

const FENCE = { admit: () => true, adopt: () => {} };

/** A store with the three tables, their sets bound, and some rows. */
async function seeded(): Promise<Map<TableDefinition, string>> {
	store = await memoryStore();
	const tables = new Map<TableDefinition, string>();
	const staged: StagedWrite[] = [];
	for (const definition of [Sessions, Teams, Notes] as TableDefinition[]) {
		const handle = await tableIn(store, definition);
		tables.set(definition, handle.sql.table);
		if (definition.exposes !== undefined) {
			store.reads.bind(definition.exposes.name, { table: handle.sql.table, definition }, tables);
		}
		const changes = new TableChanges(handle, staged);
		if (definition === Sessions) {
			for (const [index, app] of ["club", "club", "family", "club"].entries()) {
				changes.put({ id: `s${index}`, app, private: index === 2, lastTouch: 10 * index, title: `t${index}` });
			}
		} else if (definition === Teams) {
			for (const [team, session] of [
				["u12", "s0"],
				["u12", "s1"],
				["u14", "s1"],
				["u12", "gone"],
			]) {
				changes.put({ team, session });
			}
		} else {
			changes.put({ id: 1, session: "s0", n: 1 });
			changes.put({ id: 2, n: 2 });
			changes.put({ id: 3, session: "s2", n: 3 });
		}
	}
	await store.commit(staged, FENCE, context);
	return tables;
}

/** The plan of `q` over the seeded store, and its rows for `range`. */
async function planned(q: Query, range: Range = { limit: 10 }) {
	const tables = await seeded();
	const plan = new ReadPlan(q, tables.get(q.table)!, {}, "rows", store.reads);
	const { sql, params } = plan.select(range);
	const rows = await store.read((executor) => executor.all<StoredRead>(sql, ...params), context);
	return { plan, rows, tables };
}

/** The query plan SQLite chose for a statement, one line per step. */
async function explained(statement: { readonly sql: string; readonly params: readonly unknown[] }): Promise<string> {
	const steps = await store.read(
		(executor) =>
			executor.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement.sql}`, ...(statement.params as never[])),
		context,
	);
	return steps.map(({ detail }) => detail).join("; ");
}

describe("exists", () => {
	it("is true for a row with a matching row in the set's table, with and without an inner condition", async () => {
		const all = await planned(query(Sessions).where((s) => exists(TeamSessions, { session: s.id })));
		expect(all.rows.map((row) => row.id)).toEqual(["s0", "s1"]);
		const u14 = await planned(
			query(Sessions).where((s) => exists(TeamSessions, { session: s.id }, (t) => eq(t.team, "u14"))),
		);
		expect(u14.rows.map((row) => row.id)).toEqual(["s1"]);
	});

	it("negates and nests", async () => {
		const none = await planned(
			query(Sessions).where((s) => and(eq(s.app, "club"), not(exists(TeamSessions, { session: s.id })))),
		);
		expect(none.rows.map((row) => row.id)).toEqual(["s3"]);
		// Teams whose session is a club session that is itself in u14.
		const nested = await planned(
			query(Teams).where((t) =>
				exists(SessionColumns, { id: t.session }, (s) =>
					and(
						eq(s.app, "club"),
						exists(TeamSessions, { session: s.id }, (x) => eq(x.team, "u14")),
					),
				),
			),
		);
		expect(nested.rows.map((row) => [row.team, row.session])).toEqual([
			["u12", "s1"],
			["u14", "s1"],
		]);
	});

	it("matches by the key, a prefix of it, or a declared index; anything else is refused, naming the columns", () => {
		expect(() => query(Sessions).where((s) => exists(TeamSessions, { team: s.app, session: s.id }))).not.toThrow();
		expect(() => query(Sessions).where((s) => exists(TeamSessions, { team: s.app }))).not.toThrow();
		const Loose = defineColumns("loose", { columns: { a: str(), b: str() }, key: ["a"] });
		expect(() => query(Sessions).where((s) => exists(Loose, { b: s.id }))).toThrow(
			"loose is matched by (b), no leading prefix of its key (a)",
		);
		const Counted = defineColumns("counted", { columns: { n: int() }, key: ["n"] });
		expect(() => query(Sessions).where((s) => exists(Counted, { n: s.id as never }))).toThrow("differ in type");
	});

	it("is refused in writes", async () => {
		const tables = await seeded();
		const handle = await tableIn(store, Sessions);
		const changes = new TableChanges(handle, []);
		const where = (s: typeof Sessions.refs) => exists(TeamSessions, { session: s.id as never });
		expect(() => changes.updateWhere(where, { title: "x" })).toThrow("exists is for queries, not for writes");
		expect(() => changes.deleteWhere(where)).toThrow("exists is for queries, not for writes");
		expect(tables.size).toBe(3);
	});

	it("matches nothing for a NULL in a matched column: the exists is false", async () => {
		const noted = await planned(query(Notes).where((n) => exists(SessionColumns, { id: n.session })));
		expect(noted.rows.map((row) => row.id)).toEqual([1, 3]);
	});
});

describe("existsNode and whereNode", () => {
	const clubOnly = compile(SessionColumns, eq(SessionColumns.refs.app, "club"));

	it("take a condition as data: an optional pointer keeps its row, a pointer to a hidden row drops it", async () => {
		const feed = await planned(
			query(Notes).where((n) => or(isNull(n.session), existsNode(SessionColumns, { id: n.session }, clubOnly))),
		);
		expect(feed.rows.map((row) => row.id)).toEqual([1, 2]);
		const own = await planned(query(Sessions).whereNode(SessionColumns, clubOnly));
		expect(own.rows.map((row) => row.id)).toEqual(["s0", "s1", "s3"]);
	});

	it("apply to a joined set, with an exists matched on the partner", async () => {
		const inU14 = compile(
			SessionColumns,
			exists(TeamSessions, { session: SessionColumns.refs.id }, (t) => eq(t.team, "u14")),
		);
		const joined = await planned(
			query(Teams)
				.where((t) => eq(t.team, "u12"))
				.join(SessionColumns, (t) => ({ id: t.session }))
				.whereNode(SessionColumns, inU14),
		);
		expect(joined.rows.map((row) => row.session)).toEqual(["s1"]);
	});

	it("refuse a malformed node before anything is rendered", () => {
		const refused = (node: unknown): string => {
			try {
				checkNode(node, SessionColumns, "whereNode");
				return "accepted";
			} catch (error) {
				return (error as { reason?: string }).reason === "args" ? (error as Error).message : String(error);
			}
		};
		expect(refused({ like: ["app", "x"] })).toContain('unknown kind "like"');
		expect(refused({ eq: ["app", "x"], ne: ["app", "y"] })).toContain("one kind");
		expect(refused({ eq: ["app", 5] })).toContain("5 is not a str value");
		expect(refused({ eq: ["nope", "x"] })).toContain('no column "nope"');
		expect(refused({ exists: ["club.team-sessions", [], null] })).toContain("matched pairs");
		expect(refused({ exists: ["club.team-sessions", [["session", "nope"]], null] })).toContain('no column "nope"');
		let deep: unknown = { eq: ["app", "x"] };
		for (let depth = 0; depth < 20; depth++) deep = { not: deep };
		expect(refused(deep)).toContain("nested deeper");
		expect(() => query(Sessions).whereNode(TeamSessions, clubOnly)).toThrow();
	});

	it("check a nested exists against the table bound to its set when the read opens", async () => {
		const tables = await seeded();
		const plan = (node: WhereNode): ReadPlan =>
			new ReadPlan(query(Sessions).whereNode(SessionColumns, node), tables.get(Sessions)!, {}, "rows", store.reads);
		expect(() => plan({ exists: ["club.team-sessions", [["team", "id"]], { eq: ["nope", "x"] }] })).toThrow(
			'no column "nope"',
		);
		expect(() => plan({ exists: ["club.team-sessions", [["note", "id"]], null] })).toThrow("no leading prefix");
		expect(() => plan({ exists: ["nobody.serves", [["x", "id"]], null] })).toThrow(
			'column set "nobody.serves" is not served',
		);
	});
});

describe("join", () => {
	const page = query(Teams)
		.where((t) => eq(t.team, "u12"))
		.join(SessionColumns, (t) => ({ id: t.session }))
		.where((_t, session) => eq(session.app, "club"))
		.orderBy((_t, session) => session.lastTouch, "desc");

	it("pairs each row with the one row of that key, drops a row without a partner, orders by a partner column", async () => {
		const { rows } = await planned(page);
		expect(rows.map((row) => [row.session, row["sessions.columns:lastTouch"]])).toEqual([
			["s1", 10],
			["s0", 0],
		]);
	});

	it("continues after a position of a joined order, and ends through one", async () => {
		const after = await planned(page, { after: [10, "u12", "s1"], limit: 10 });
		expect(after.rows.map((row) => row.session)).toEqual(["s0"]);
		const through = await planned(page, { through: [10, "u12", "s1"], limit: 10 });
		expect(through.rows.map((row) => row.session)).toEqual(["s1"]);
		// A position of the leading order columns alone bounds every row equal in them.
		const prefix = await planned(page, { through: [10], limit: 10 });
		expect(prefix.rows.map((row) => row.session)).toEqual(["s1"]);
	});

	it("refuses a match short of the whole key, a second join, the table's own set and a column of another type", () => {
		const teams = query(Sessions);
		expect(() => teams.join(TeamSessions, (s) => ({ session: s.id }))).toThrow("the match covers the whole key");
		expect(() => page.join(TeamSessions, (t) => ({ team: t.team, session: t.session }))).toThrow("joins one set");
		expect(() => query(Teams).join(TeamSessions, (t) => ({ team: t.team, session: t.session }))).toThrow(
			"the set is the table's own",
		);
		expect(() => query(Notes).join(SessionColumns, (n) => ({ id: n.n as never }))).toThrow("differ in type");
	});

	it("is driven from the query's own table, whatever the planner would prefer", async () => {
		const { plan } = await planned(page);
		expect(await explained(plan.select({ limit: 51 }))).toMatch(/^SEARCH t .*; SEARCH p USING PRIMARY KEY/);
	});

	it("fails a read whose partner column is not what it was written for", async () => {
		const tables = await seeded();
		const Other = defineColumns("sessions.columns", { columns: { id: str(), app: int() }, key: ["id"] });
		const q = query(Teams)
			.join(Other, (t) => ({ id: t.session }))
			.where((_t, session) => eq(session.app, 1));
		expect(() => new ReadPlan(q, tables.get(Teams)!, {}, "rows", store.reads)).toThrow(
			'column "app" of column set "sessions.columns" is not what this read was written for',
		);
	});
});

describe("uses and the probe", () => {
	it("lists each table a read uses with the columns it depends on", async () => {
		const q = query(Teams)
			.where((t) => inArray(t.team, ["u12"]))
			.join(SessionColumns, (t) => ({ id: t.session }))
			.where((_t, session) => and(eq(session.app, "club"), isNull(session.archivedAt)))
			.orderBy((_t, session) => session.lastTouch, "desc");
		const tables = await seeded();
		const plan = new ReadPlan(q, tables.get(Teams)!, { reads: [], partnerReads: ["id"] }, "rows", store.reads);
		const [own, joined] = plan.uses;
		expect([own!.role, [...own!.depends].sort()]).toEqual(["own", ["session", "team"]]);
		expect([joined!.role, [...joined!.depends].sort(), [...joined!.enters].sort()]).toEqual([
			"joined",
			["app", "archivedAt", "id", "lastTouch"],
			["app", "archivedAt", "lastTouch"],
		]);
		// The match column after the column the query fixes: the key (team, session).
		expect([joined!.pairs, joined!.keyed]).toEqual([["session"], true]);
		const counted = new ReadPlan(q, tables.get(Teams)!, {}, "count", store.reads);
		expect([...counted.uses[1]!.depends].sort()).toEqual(["app", "archivedAt", "id"]);
	});

	it("is one keyed lookup: by the own key, by a join's match, by an exists' match", async () => {
		const tables = await seeded();
		const team = query(Teams)
			.where((t) => eq(t.team, "u12"))
			.join(SessionColumns, (t) => ({ id: t.session }))
			.orderBy((_t, session) => session.lastTouch, "desc");
		const teamPlan = new ReadPlan(team, tables.get(Teams)!, {}, "rows", store.reads);
		expect(await explained(teamPlan.probe({ limit: 1 }, ["session"], ["s1"]))).toMatch(
			/^SEARCH t USING PRIMARY KEY \(team=\? AND session=\?\)/,
		);
		const visible = query(Sessions)
			.where((s) =>
				and(
					eq(s.app, "club"),
					exists(TeamSessions, { session: s.id }, (t) => eq(t.team, "u12")),
				),
			)
			.orderBy((s) => s.lastTouch, "desc");
		const visiblePlan = new ReadPlan(visible, tables.get(Sessions)!, {}, "rows", store.reads);
		expect(await explained(visiblePlan.probe({ limit: 1 }, ["id"], ["s1"]))).toMatch(
			/^SEARCH t USING PRIMARY KEY \(id=\?\)/,
		);
		const use = visiblePlan.uses.find(({ role }) => role === "exists")!;
		expect([use.pairedBy, use.pairs, use.keyed, use.stable]).toEqual([["session"], ["id"], true, true]);
	});

	it("has no keyed probe where the own table has no index for the match", async () => {
		const tables = await seeded();
		const q = query(Notes).join(SessionColumns, (n) => ({ id: n.session }));
		const plan = new ReadPlan(q, tables.get(Notes)!, {}, "rows", store.reads);
		expect(plan.uses[1]!.keyed).toBe(false);
	});
});

describe("what a read was written for, checked when it opens (code review round 1)", () => {
	const Own = defineTable("own", { version: 1, columns: { id: int(), partner: str() }, key: ["id"] });

	it("refuses a joined set whose key the bound table has differently: the join would pair a row with several", () => {
		// Sol 1, Astra S2.
		const Old = defineColumns("partners", { columns: { id: str(), tenant: str() }, key: ["id"] });
		const New = defineColumns("partners", { columns: { id: str(), tenant: str() }, key: ["id", "tenant"] });
		const Partner = defineTable("partner", { version: 1, columns: New.columns, key: ["id", "tenant"], exposes: New });
		const q = query(Own).join(Old, (row) => ({ id: row.partner }));
		const bindings = new Map([[Old.name, { table: "partner", definition: Partner as TableDefinition }]]);
		expect(() => new ReadPlan(q, "own", {}, "rows", bindings)).toThrow(
			'column set "partners" is joined by (id), its key is (id, tenant): not what this read was written for',
		);
	});

	it("refuses a column an exists compares that the bound table has with another type; an unused one may change", () => {
		// Sol 1: the reader compares `score` as an int; the publisher made it a num.
		const Old = defineColumns("scores", { columns: { id: int(), score: int(), note: str() }, key: ["id"] });
		const retyped = { id: int(), score: num(), note: str() };
		const Retyped = defineColumns("scores", { columns: retyped, key: ["id"] });
		const Unused = defineColumns("scores", { columns: { id: int(), score: int(), note: int() }, key: ["id"] });
		const bound = (set: typeof Retyped | typeof Unused) => {
			const definition = defineTable("other", { version: 1, columns: set.columns, key: ["id"], exposes: set });
			return new Map([[set.name, { table: "other", definition: definition as TableDefinition }]]);
		};
		const q = query(Own).where((row) => exists(Old, { id: row.id }, (t) => eq(t.score, 1)));
		expect(() => new ReadPlan(q, "own", {}, "rows", bound(Retyped))).toThrow(
			'column "score" of column set "scores" is not what this read was written for',
		);
		expect(() => new ReadPlan(q, "own", {}, "rows", bound(Unused))).not.toThrow();
	});

	it("takes a condition as data only with canonical host keys, and no ordering of a host column", () => {
		const Project = hostKind("project", { id: str() });
		const Owned = defineColumns("owned", { columns: { id: int(), project: host(Project) }, key: ["id"] });
		const refused = (node: unknown): string => {
			try {
				checkNode(node, Owned, "whereNode");
				return "accepted";
			} catch (error) {
				return (error as Error).message;
			}
		};
		const key = compile(Owned, eq(Owned.refs.project, Project({ id: "p1" })));
		expect(refused(key)).toBe("accepted");
		expect(refused({ eq: ["project", "p1"] })).toContain('"p1" is no address key of project');
		expect(refused({ inArray: ["project", ["session|p1"]] })).toContain("is no address key of project");
		expect(refused({ lt: ["project", "project|p1"] })).toContain('lt on host(...) column "project"');
		expect(refused({ prefix: ["project", "project|"] })).toContain("prefix on host(...) column");
		expect(refused({ isNull: "project" })).toContain("isNull on host(...) column");
	});
});

describe("a table handle's own reads", () => {
	it("page and count take an exists, and refuse a joined query instead of ignoring the join", async () => {
		// Astra S3.
		await seeded();
		const sessions = await tableIn(store, Sessions);
		const inTeam = query(Sessions).where((s) => exists(TeamSessions, { session: s.id }));
		expect((await sessions.page(inTeam, 10, context)).items.map((row) => row.id)).toEqual(["s0", "s1"]);
		expect(await sessions.count(inTeam, context)).toBe(2);
		const teams = await tableIn(store, Teams);
		const joined = query(Teams).join(SessionColumns, (t) => ({ id: t.session }));
		await expect(teams.page(joined, 10, context)).rejects.toThrow("a joined query is read as a named query");
		await expect(teams.count(joined, context)).rejects.toThrow("a joined query is read as a named query");
	});
});

describe("a named query's shape, shared (hot-path pass)", () => {
	const ofApp = (app: string) => query(Sessions).where((s) => eq(s.app, app));
	const inTeams = (app: string) =>
		query(Sessions).where((s) => and(eq(s.app, app), exists(TeamSessions, { session: s.id })));

	/** Opens a read of `q` sharing its shape through `slot`, loaded; its runs collected. */
	async function opened(q: Query, slot: ShapeSlot, tables: Map<TableDefinition, string>, batch: Batch) {
		const spec = { query: q, table: tables.get(Sessions)!, projection: {}, owner: tables, shapes: slot };
		const open = new OpenQuery({ store, batch }, spec, "rows", { rebound: () => {} }, context);
		const runs: ReadRun[] = [];
		const read = open.read({ kind: "rows", range: { limit: 10 } }, { adopt: (run) => void runs.push(run) });
		await read.load(context);
		return {
			open,
			read,
			runs,
			plan: () => (open.compiled as Extract<typeof open.compiled, { kind: "compiled" }>).plan,
		};
	}

	/** Commits `write`'s writes to `handle`'s table with the refresh a transaction stages: its runs, probes and skips. */
	async function costOf(handle: TableHandle, batch: Batch, write: (changes: TableChanges) => void) {
		const meter = await metered();
		const staged: StagedWrite[] = [];
		const changes = new TableChanges(handle, staged);
		write(changes);
		const refresh = new ReadRefresh(store.reads, [handle.sql.table], () => changes.changes(), meter.context);
		staged.push(refresh.write);
		const fence = { admit: () => true, adopt: () => batch.commit(() => refresh.adopt(), meter.context) };
		await store.commit(staged, fence, meter.context);
		const counts = meter.counts();
		return [counts["chord.query.runs"] ?? 0, counts["chord.query.probes"] ?? 0, counts["chord.query.skips"] ?? 0];
	}

	it("is one for plans whose products are equal, and never across other texts, slots or none", async () => {
		const tables = await seeded();
		const slot: ShapeSlot = { last: undefined };
		const plan = (q: Query, shared: ShapeSlot | undefined = slot) =>
			new ReadPlan(q, tables.get(Sessions)!, {}, "rows", store.reads, shared);
		const club = plan(ofApp("club"));
		const family = plan(ofApp("family"));
		expect(family.uses).toBe(club.uses);
		expect(family.select({ limit: 5 }).sql).toBe(club.select({ limit: 5 }).sql);
		expect([club.select({ limit: 5 }).params, family.select({ limit: 5 }).params]).toEqual([
			["club", 5],
			["family", 5],
		]);
		// Equalities stay the read's own.
		expect([[...club.equalities], [...family.equalities]]).toEqual([[["app", ["club"]]], [["app", ["family"]]]]);
		// A prefix with an upper bound is a range, one without (only U+10FFFF) a lower bound alone: other texts.
		const bounded = plan(query(Sessions).where((s) => prefix(s.id, "s")));
		const unbounded = plan(query(Sessions).where((s) => prefix(s.id, "\u{10FFFF}")));
		expect(unbounded.select({ limit: 1 }).sql).not.toBe(bounded.select({ limit: 1 }).sql);
		expect(unbounded.uses).not.toBe(bounded.uses);
		// One slot holds the last shape: the club's is made again, other slots and none share nothing.
		expect(plan(ofApp("club")).uses).not.toBe(club.uses);
		expect(plan(ofApp("club"), { last: undefined }).uses).not.toBe(club.uses);
		const alone = () => new ReadPlan(ofApp("club"), tables.get(Sessions)!, {}, "rows", store.reads);
		expect(alone().uses).not.toBe(alone().uses);
	});

	it("normalizes a condition's equalities once per plan, not per registration of a read (hot-path review)", async () => {
		// Astra, 0c796cefb: a list's pages register again as they split and merge; an `inArray` of 10,000 strings
		// (past the bucket limit) was normalized again at each registration.
		store = await memoryStore();
		const Docs = defineTable("docs", { version: 1, columns: { id: str() }, key: ["id"] });
		const ids = Array.from({ length: 10_000 }, (_, at) => String(at));
		const handle = await tableIn(store, Docs);
		const spec = {
			query: query(Docs).where((row) => inArray(row.id, ids)),
			table: handle.sql.table,
			projection: {},
			owner: handle,
		};
		const open = new OpenQuery(
			{ store, batch: new Batch(() => {}, undefined) },
			spec,
			"rows",
			{ rebound: () => {} },
			context,
		);
		const toWellFormed = String.prototype.toWellFormed;
		let normalized = 0;
		const spy = vi.spyOn(String.prototype, "toWellFormed").mockImplementation(function (this: string) {
			normalized++;
			return toWellFormed.call(this);
		});
		try {
			for (let page = 0; page < 20; page++) {
				open.readKnown({ after: [String(page)], through: [String(page + 1)], limit: 1 }, [], { adopt: () => {} });
			}
		} finally {
			spy.mockRestore();
			open.close();
		}
		expect(normalized).toBe(0);
	});

	it("leaves the equalities per read: two reads of one shape are filed under their own buckets", async () => {
		const tables = await seeded();
		const batch = new Batch(() => {}, undefined);
		const slot: ShapeSlot = { last: undefined };
		const club = await opened(ofApp("club"), slot, tables, batch);
		const family = await opened(ofApp("family"), slot, tables, batch);
		expect(family.plan().uses).toBe(club.plan().uses);
		const sessions = await tableIn(store, Sessions);
		// A new family session: the family read alone is a candidate; its probe finds the row and it runs.
		const put = { id: "s9", app: "family", private: false, lastTouch: 90, title: "t9" };
		expect(await costOf(sessions, batch, (changes) => changes.put(put))).toEqual([1, 1, 0]);
		expect(club.runs).toHaveLength(1);
		expect(family.runs.at(-1)).toMatchObject({ kind: "rows", result: { rows: [{ id: "s2" }, { id: "s9" }] } });
	});

	it("follows a rebound exists table into its uses, and a refused binding neither installs nor revives a shape", async () => {
		const tables = await seeded();
		const batch = new Batch(() => {}, undefined);
		// The same set with a key the match is no part of: a written row may pair with other sessions before and after.
		const ByTeam = defineColumns("club.team-sessions", {
			columns: TeamSessions.columns,
			key: ["team"],
			indexes: { ofSession: ["session"] },
		});
		const byTeamTable = defineTable("teams-by-team", {
			version: 1,
			columns: ByTeam.columns,
			key: ["team"],
			indexes: { of_session: ["session"] },
			exposes: ByTeam,
		});
		const Retyped = defineColumns("club.team-sessions", { columns: { team: str(), session: int() }, key: ["team"] });
		const retypedTable = defineTable("teams-retyped", {
			version: 1,
			columns: Retyped.columns,
			key: ["team"],
			exposes: Retyped,
		});
		const teams = await tableIn(store, Teams);
		const byTeam = await tableIn(store, byTeamTable as TableDefinition);
		const retyped = await tableIn(store, retypedTable as TableDefinition);
		const bind = (handle: TableHandle) =>
			store.reads.bind(TeamSessions.name, { table: handle.sql.table, definition: handle.definition }, tables);
		const slot: ShapeSlot = { last: undefined };
		const club = await opened(inTeams("club"), slot, tables, batch);
		const existsUse = () => club.plan().uses.find(({ role }) => role === "exists")!;
		expect(existsUse().stable).toBe(true);
		// A team row of a family session: the probe finds no club session for it.
		expect(await costOf(teams, batch, (changes) => changes.put({ team: "u20", session: "s2" }))).toEqual([0, 1, 1]);

		bind(byTeam);
		await club.read.load(context);
		expect(existsUse().stable).toBe(false);
		const unstable = club.plan().uses;
		const family = await opened(inTeams("family"), slot, tables, batch);
		expect(family.plan().uses).toBe(unstable);
		// Not stable: the read runs, no probe can rule the write out.
		expect(await costOf(byTeam, batch, (changes) => changes.put({ team: "u20", session: "s2" }))).toEqual([2, 0, 0]);

		bind(retyped);
		await club.read.load(context);
		expect(club.runs.at(-1)).toMatchObject({ kind: "failed" });
		expect(((club.runs.at(-1) as Extract<ReadRun, { kind: "failed" }>).error as Error).message).toBe(
			'column "session" of column set "club.team-sessions" is not what this read was written for',
		);
		expect(slot.last?.deref()?.uses).toBe(unstable);
		// Neither read is registered: a write to the refused table runs, probes and skips nothing.
		expect(await costOf(retyped, batch, (changes) => changes.put({ team: "u20", session: 2 }))).toEqual([0, 0, 0]);

		bind(teams);
		await club.read.load(context);
		await family.read.load(context);
		expect(existsUse().stable).toBe(true);
		expect(club.plan().uses).not.toBe(unstable);
		expect(family.plan().uses).toBe(club.plan().uses);
	});

	it("is collected with its last read; the first read's query and condition go before it", async () => {
		const tables = await seeded();
		const batch = new Batch(() => {}, undefined);
		const slot: ShapeSlot = { last: undefined };
		const condition = (app: string) => compile(SessionColumns, eq(SessionColumns.refs.app, app));
		const first = await (async () => {
			const node = condition("club");
			const q = query(Sessions).whereNode(SessionColumns, node);
			const { open } = await opened(q, slot, tables, batch);
			return { open, node: new WeakRef(node as object), query: new WeakRef(q) };
		})();
		const second = await opened(query(Sessions).whereNode(SessionColumns, condition("family")), slot, tables, batch);
		expect(slot.last?.deref()?.uses).toBe(second.plan().uses);
		first.open.close();
		const { node, query: q } = first;
		(first as { open?: OpenQuery }).open = undefined;
		await expectCollected(node, q);
		expect(slot.last?.deref()?.uses).toBe(second.plan().uses);
		second.open.close();
		const shape = slot.last!;
		(second as { open?: OpenQuery }).open = undefined;
		(second as { plan?: unknown }).plan = undefined;
		(second as { read?: unknown }).read = undefined;
		await expectCollected(shape);
	});
});

describe("a plan's statement texts (hot-path review)", () => {
	it("finds a probe's text about as fast among thousands of shapes as among a few", () => {
		// astra2, ccd99ec5c: every probe scanned every text rendered so far (4,960 three-column probe shapes: 15 times
		// slower). Past a few the texts are found in a map; the guard is a ratio of two timings in one process.
		const names = Array.from({ length: 32 }, (_, at) => `v${at}`);
		const Readings = defineTable("readings", {
			version: 1,
			columns: Object.fromEntries(names.map((name) => [name, int()])),
			key: ["v0"],
		});
		const triples = names.flatMap((a, i) =>
			names.slice(i + 1).flatMap((b, j) => names.slice(i + j + 2).map((c) => [a, b, c])),
		);
		const timed = (shapes: readonly string[][]): number => {
			const plan = new ReadPlan(query(Readings), "readings", {}, "rows", new Map());
			for (const columns of shapes) plan.probe({ limit: 1 }, columns, [1, 1, 1]);
			const last = shapes.at(-1)!;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 5; round++) {
				const started = performance.now();
				for (let call = 0; call < 20_000; call++) plan.probe({ limit: 1 }, last, [1, 1, 1]);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		expect(triples).toHaveLength(4_960);
		const few = timed(triples.slice(0, 4));
		const many = timed(triples);
		expect(many / few).toBeLessThan(5);
	});
});
