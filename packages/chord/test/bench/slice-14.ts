// Benchmark and acceptance of slice 14 (`docs/slice-14.md` §9): the ordinary screens of an app with persons, at the
// spec's data (10,000 sessions: a club of 3,000 in ten teams of 300 and one of 20, a family of 3,000, 4,000 archived
// elsewhere) and its mix of open reads (10 family members, 10 club members in two teams each, a guest with 2 shares, a
// member of the team of 20, 20 workers). It measures one run of each kind of read, and what one touch of a club
// session costs every open read: the runs and keyed probes it causes (exact, from the counters) and the time of its
// commit step. It exits 1 when a number of §9 is missed.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types test/bench/slice-14.ts
import { performance } from "node:perf_hooks";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "../../src/context/index.ts";
import {
	arr,
	bool,
	int,
	local,
	method,
	type NamedQuery,
	obj,
	opt,
	queries,
	type Static,
	str,
	unknown,
} from "../../src/contracts/index.ts";
import type { Reference } from "../../src/host/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { constant } from "../../src/state/index.ts";
import {
	and,
	compile,
	defineColumns,
	defineTable,
	eq,
	exists,
	existsNode,
	gte,
	inArray,
	isNull,
	openStore,
	or,
	query,
	sqliteBackend,
} from "../../src/store/index.ts";
import type { ChordStore } from "../../src/store/store.ts";

const TEAMS = Array.from({ length: 10 }, (_, index) => `u${index}`);
const ACTIVE = ["working", "waiting", "failed"];
/** Sessions touched after this are "recent": about 330 of them. */
const SINCE = 9_670;
const PAGE = 50;

const SessionColumns = defineColumns("bench.session-columns", {
	columns: {
		id: str(),
		app: str(),
		title: str(),
		creator: str(),
		private: bool(),
		state: str(),
		lastTouch: int(),
		archivedAt: opt(int()),
	},
	key: ["id"],
});
const SessionRows = defineTable("session-rows", {
	version: 1,
	columns: { ...SessionColumns.columns, cwd: str({ default: "/" }) },
	key: ["id"],
	indexes: {
		by_app: ["app", "lastTouch"],
		by_creator: ["app", "creator", "lastTouch"],
		by_state: ["state", "lastTouch"],
		by_touch: ["lastTouch"],
	},
	exposes: SessionColumns,
});
const TeamSessions = defineColumns("bench.team-sessions", {
	columns: { team: str(), session: str() },
	key: ["team", "session"],
	indexes: { ofSession: ["session"] },
});
const TeamRows = defineTable("team-rows", {
	version: 1,
	columns: { ...TeamSessions.columns },
	key: ["team", "session"],
	indexes: { of_session: ["session"] },
	exposes: TeamSessions,
});
const ShareColumns = defineColumns("bench.shares", {
	columns: { person: str(), session: str() },
	key: ["person", "session"],
	indexes: { ofSession: ["session"] },
});
const ShareRows = defineTable("share-rows", {
	version: 1,
	columns: { ...ShareColumns.columns },
	key: ["person", "session"],
	indexes: { of_session: ["session"] },
	exposes: ShareColumns,
});
const MarkRows = defineTable("mark-rows", {
	version: 1,
	columns: { person: str(), session: str(), at: int() },
	key: ["person", "session"],
});
const NoteRows = defineTable("note-rows", {
	version: 1,
	columns: { id: int(), person: str(), session: opt(str()), at: int() },
	key: ["id"],
	indexes: { of_person: ["person", "at"] },
});

const Item = obj({ id: str(), title: str(), state: str(), lastTouch: int() });
const Session = obj({
	id: str(),
	app: str(),
	creator: str(),
	state: str(),
	lastTouch: int(),
	archived: bool(),
});

/** One store for the bench: the tables of several plugins of an app, with the named queries of §8. */
const Store = local("bench.store", {
	version: 1,
	params: {},
	members: {
		sessions: queries(Item, {
			visible: obj({ app: str(), condition: unknown() }),
			one: obj({ id: str(), condition: unknown() }),
			createdBy: obj({ app: str(), person: str(), condition: unknown() }),
			inStates: obj({ states: arr(str()), condition: unknown() }),
			since: obj({ since: int(), condition: unknown() }),
		}),
		teams: queries(Item, { ofTeams: obj({ teams: arr(str()), condition: unknown() }) }),
		shares: queries(Item, { sessionsOf: obj({ person: str(), app: str(), condition: unknown() }) }),
		marks: queries(Item, { ofPerson: obj({ person: str(), condition: unknown() }) }),
		notes: queries(obj({ id: int() }), { forPerson: obj({ person: str(), condition: unknown() }) }),
		seed: method(
			obj({
				sessions: arr(Session),
				teams: arr(obj({ team: str(), session: str() })),
				shares: arr(obj({ person: str(), session: str() })),
			}),
		),
		touch: method(obj({ id: str(), at: int(), state: str() })),
		archive: method(obj({ id: str(), at: int() })),
	},
});

type Args = { readonly condition: unknown };
const item = (row: { id: string; title: string; state: string; lastTouch: number }) => ({
	id: row.id,
	title: row.title,
	state: row.state,
	lastTouch: row.lastTouch,
});
const partner = (_row: unknown, session: { readonly [column: string]: unknown }) =>
	item(session as { id: string; title: string; state: string; lastTouch: number });
const READS = ["id", "title", "state", "lastTouch"] as const;

const storeFacet = defineFacet((h) =>
	h.serve(Store, (_, self) => {
		const [sessions, teams, shares, marks, notes] = [
			self.table(SessionRows),
			self.table(TeamRows),
			self.table(ShareRows),
			self.table(MarkRows),
			self.table(NoteRows),
		];
		const joined = { map: partner, reads: [], partnerReads: READS };
		return {
			sessions: self.queries(
				sessions,
				{ map: item, reads: READS },
				{
					// by_app (app, lastTouch)
					visible: (args: Args & { app: string }) =>
						query(SessionRows)
							.where((s) => eq(s.app, args.app))
							.whereNode(SessionColumns, args.condition)
							.orderBy((s) => s.lastTouch, "desc"),
					one: (args: Args & { id: string }) =>
						query(SessionRows)
							.where((s) => eq(s.id, args.id))
							.whereNode(SessionColumns, args.condition),
					// by_creator (app, creator, lastTouch)
					createdBy: (args: Args & { app: string; person: string }) =>
						query(SessionRows)
							.where((s) => and(eq(s.app, args.app), eq(s.creator, args.person)))
							.whereNode(SessionColumns, args.condition)
							.orderBy((s) => s.lastTouch, "desc"),
					// by_state (state, lastTouch): ordered by state first, or SQLite walks every session by last touch.
					inStates: (args: Args & { states: string[] }) =>
						query(SessionRows)
							.where((s) => inArray(s.state, args.states))
							.whereNode(SessionColumns, args.condition)
							.orderBy((s) => s.state, "desc")
							.orderBy((s) => s.lastTouch, "desc"),
					// by_touch (lastTouch)
					since: (args: Args & { since: number }) =>
						query(SessionRows)
							.where((s) => gte(s.lastTouch, args.since))
							.whereNode(SessionColumns, args.condition)
							.orderBy((s) => s.lastTouch, "desc"),
				},
			),
			teams: self.queries(teams, joined, {
				// The key (team, session): driven from the teams' rows, ordered by the sessions' last touch.
				ofTeams: (args: Args & { teams: string[] }) =>
					query(TeamRows)
						.where((t) => inArray(t.team, args.teams))
						.join(SessionColumns, (t) => ({ id: t.session }))
						.where((_t, session) => and(eq(session.app, "club"), isNull(session.archivedAt)))
						.whereNode(SessionColumns, args.condition)
						.orderBy((_t, session) => session.lastTouch, "desc"),
			}),
			shares: self.queries(shares, joined, {
				sessionsOf: (args: Args & { person: string; app: string }) =>
					query(ShareRows)
						.where((x) => eq(x.person, args.person))
						.join(SessionColumns, (x) => ({ id: x.session }))
						.where((_x, session) => eq(session.app, args.app))
						.whereNode(SessionColumns, args.condition)
						.orderBy((_x, session) => session.lastTouch, "desc"),
			}),
			marks: self.queries(marks, joined, {
				// The person's own rows drive, ordered by their own column.
				ofPerson: (args: Args & { person: string }) =>
					query(MarkRows)
						.where((m) => eq(m.person, args.person))
						.join(SessionColumns, (m) => ({ id: m.session }))
						.whereNode(SessionColumns, args.condition)
						.orderBy((m) => m.at, "desc"),
			}),
			notes: self.queries(
				notes,
				{ map: (row) => ({ id: row.id }), reads: ["id"] },
				{
					forPerson: (args: Args & { person: string }) =>
						query(NoteRows)
							.where((n) =>
								and(
									eq(n.person, args.person),
									or(isNull(n.session), existsNode(SessionColumns, { id: n.session }, args.condition)),
								),
							)
							.orderBy((n) => n.at, "desc"),
				},
			),
			seed: async (rows, ctx) => {
				await self.tx(async (tx) => {
					for (const { archived, ...row } of rows.sessions) {
						tx.put(sessions, {
							...row,
							title: `session ${row.id}`,
							private: false,
							...(archived ? { archivedAt: 1 } : {}),
						});
					}
					for (const row of rows.teams) tx.put(teams, row);
					for (const row of rows.shares) tx.put(shares, row);
				}, ctx);
				return null;
			},
			// A touch names what it changes: an `update`, not a `put` (§3.3).
			touch: async ({ id, at, state }, ctx) => {
				await self.tx(async (tx) => tx.update(sessions, { id }, { lastTouch: at, state }), ctx);
				return null;
			},
			archive: async ({ id, at }, ctx) => {
				await self.tx(async (tx) => tx.update(sessions, { id }, { archivedAt: at }), ctx);
				return null;
			},
		};
	}),
);

/** What a person may see, and their rule in one app alone (what a list's dense source walks). */
function access(person: string, app: "family" | "club" | "none", teams: readonly string[]) {
	const s = SessionColumns.refs;
	const family = or(eq(s.private, false), eq(s.creator, person));
	const club = or(
		eq(s.creator, person),
		exists(TeamSessions, { session: s.id }, (t) => inArray(t.team, teams)),
	);
	const shared = and(
		inArray(s.app, ["family"]),
		exists(ShareColumns, { session: s.id }, (x) => eq(x.person, person)),
	);
	const rule = app === "family" ? family : app === "club" ? club : or();
	const own = app === "none" ? [] : [and(eq(s.app, app), rule)];
	return { rule: compile(SessionColumns, rule), condition: compile(SessionColumns, or(...own, shared)) };
}

const Listed = obj({ rows: arr(Item), moreAfter: bool() });
/**
 * One open read of a person: `kind` names the screen's read, `arg` its team or session. A list for a screen's list
 * (each source of a list over several sources is a list of its own until those are built), a live query of one row
 * for a worker, a count for a team page.
 */
const Screen = local("bench.screen", {
	version: 1,
	params: { kind: str(), person: str(), app: str(), teams: str(), arg: str() },
	members: { list: Listed, one: obj({ rows: arr(Item), more: bool() }), count: int(), more: method() },
});

const screenFacet = defineFacet((h) =>
	h.serve(Screen, ({ kind, person, app, teams: joinedTeams, arg }, self) => {
		const store = self.get(Store, {});
		const teams = joinedTeams === "" ? [] : joinedTeams.split(",");
		const { rule, condition } = access(person, app as "family" | "club" | "none", teams);
		const none = constant(0);
		const nothing = constant({ rows: [], more: false });
		const listed = <A>(source: readonly [NamedQuery<Static<typeof Item>, A>, A]) => {
			const list = self.list("rows", [source], { first: PAGE });
			return { list: list.value, one: nothing, count: none, more: (ctx: Context) => list.more(ctx) };
		};
		switch (kind) {
			case "team": {
				const args = { teams: [arg], condition };
				return { ...listed([store.teams.ofTeams, args]), count: self.count(store.teams.ofTeams, args) };
			}
			case "club-teams":
				return listed([store.teams.ofTeams, { teams, condition }]);
			case "created":
				return listed([store.sessions.createdBy, { app, person, condition }]);
			case "rule":
				return listed([store.sessions.visible, { app: arg, condition: rule }]);
			case "shares":
				return listed([store.shares.sessionsOf, { person, app: arg, condition }]);
			case "active":
				return listed([store.sessions.inStates, { states: ACTIVE, condition }]);
			case "recent":
				return listed([store.sessions.since, { since: SINCE, condition }]);
			case "marks":
				return listed([store.marks.ofPerson, { person, condition }]);
			default: {
				// A worker following its session (`principal.kind === "worker"`: nothing is hidden from it).
				const all = compile(SessionColumns, and());
				const one = self.liveQuery(store.sessions.one, { id: arg, condition: all }, { first: 1 });
				return { list: constant({ rows: [], moreAfter: false }), one, count: none, more: async () => null };
			}
		}
	}),
);

/** The spec's data: 10,000 session rows, the teams' rows, the guest's two shares. */
function data() {
	const sessions: Static<typeof Session>[] = [];
	const teams: { team: string; session: string }[] = [];
	const row = (id: string, app: string, n: number, archived = false) => ({
		id,
		app,
		creator: `p${n % 40}`,
		// 200 working, waiting or failed.
		state: !archived && n % 30 === 0 ? ACTIVE[n % 3]! : "idle",
		lastTouch: 1 + ((n * 7919) % 9_999),
		archived,
	});
	let n = 0;
	for (let index = 0; index < 3_000; index++) {
		const id = `club-${index}`;
		sessions.push(row(id, "club", n++));
		teams.push({ team: TEAMS[index % 10]!, session: id });
	}
	for (let index = 0; index < 20; index++) {
		const id = `tiny-${index}`;
		sessions.push(row(id, "club", n++));
		teams.push({ team: "tiny", session: id });
	}
	for (let index = 0; index < 3_000; index++) sessions.push(row(`family-${index}`, "family", n++));
	for (let index = 0; index < 3_980; index++) sessions.push(row(`old-${index}`, "other", n++, true));
	const shares = [
		{ person: "guest", session: "family-5" },
		{ person: "guest", session: "family-900" },
	];
	return { sessions, teams, shares };
}

type Person = { readonly person: string; readonly app: "family" | "club" | "none"; readonly teams: readonly string[] };

/** The persons of the mix, `scale` times: family members, club members in two teams each, a guest, a tiny team's member. */
function persons(scale: number): Person[] {
	const all: Person[] = [];
	for (let copy = 0; copy < scale; copy++) {
		for (let index = 0; index < 10; index++) {
			all.push({ person: `f${copy}-${index}`, app: "family", teams: [] });
			all.push({ person: `c${copy}-${index}`, app: "club", teams: [TEAMS[index]!, TEAMS[(index + 1) % 10]!] });
		}
		all.push({ person: `guest${copy === 0 ? "" : copy}`, app: "none", teams: [] });
		all.push({ person: `t${copy}`, app: "club", teams: ["tiny"] });
	}
	return all;
}

/** The reads each person has open, as `Screen` params. */
function screens({ person, app, teams }: Person, workers: readonly string[]) {
	const base = { person, app, teams: teams.join(",") };
	const open = ["active", "recent"].map((kind) => ({ ...base, kind, arg: "" }));
	// Pinned and unread: two lists over the person's own rows.
	open.push({ ...base, kind: "marks", arg: "pinned" }, { ...base, kind: "marks", arg: "unread" });
	// A list in the person's app: its sources as separate reads here; `self.list` merges them (§4).
	if (app === "club") {
		open.push({ ...base, kind: "club-teams", arg: "" }, { ...base, kind: "created", arg: "" });
		for (const team of teams) open.push({ ...base, kind: "team", arg: team });
	} else {
		open.push({ ...base, kind: "rule", arg: "family" }, { ...base, kind: "shares", arg: "family" });
	}
	for (const session of workers) open.push({ ...base, kind: "one", arg: session });
	return open;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const failures: string[] = [];
function expectAtMost(what: string, value: number, budget: number, unit: string): void {
	const ok = value <= budget;
	if (!ok) failures.push(what);
	console.log(`${ok ? "  ok  " : "  MISS"} ${what}: ${value.toFixed(3)} ${unit} (budget ${budget})`);
}
function expectExactly(what: string, value: number, expected: number): void {
	const ok = value === expected;
	if (!ok) failures.push(what);
	console.log(`${ok ? "  ok  " : "  MISS"} ${what}: ${value} (expected ${expected})`);
}

/** A host over a seeded store with the mix `scale` times open, and its counters. */
async function mixed(scale: number) {
	const telemetry = new InMemoryTelemetryContext();
	const context = withTelemetry(await telemetry.startSpan({ name: "bench" }, (span) => span), BACKGROUND_CONTEXT);
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const host: Host = createHost({ store, telemetry, onError: (error) => console.error(error) });
	await host.load(
		[
			{ name: "@bench/store", facet: storeFacet },
			{ name: "@bench/screens", facet: screenFacet },
		],
		context,
	);
	const app = await host.get(Store, {}, context);
	const rows = data();
	for (let from = 0; from < rows.sessions.length; from += 1_000) {
		const chunk = { sessions: rows.sessions.slice(from, from + 1_000), teams: [], shares: [] };
		await app.seed(from === 0 ? { ...chunk, teams: rows.teams, shares: rows.shares } : chunk, context);
	}
	// The touched session, recent and working: on the first page of its team (u3), of its members' lists and sidebars.
	await app.touch({ id: "club-3", at: 20_000, state: "working" }, context);
	const everyone = persons(scale);
	// 20 workers per mix, each following a session: the touched one and others.
	const workers = Array.from({ length: 20 * scale }, (_, index) => (index === 0 ? "club-3" : `family-${index}`));
	const held: Reference<typeof Screen>[] = [];
	for (const [index, person] of everyone.entries()) {
		const own = workers.filter((_, worker) => worker % everyone.length === index);
		for (const params of screens(person, own)) held.push(await host.get(Screen, params, context));
	}
	const counter = (name: string): number =>
		telemetry
			.getMetrics()
			.filter((metric) => metric.name === name)
			.reduce((sum, metric) => sum + metric.value, 0);
	const close = async (): Promise<void> => {
		for (const each of held) each.release();
		app.release();
		await host.close(context);
		await store.close(context);
	};
	// Every screen is one read; a team page also counts its team.
	const reads =
		held.length + everyone.reduce((sum, { app: of, teams }) => sum + (of === "club" ? teams.length : 0), 0);
	return { host, app, context, counter, reads, close };
}

console.log(
	"slice 14, §9: per run (one read of a page of 50 rows through `page`, Chord's decoding and mapping included)",
);
{
	const { app, context, close } = await mixed(0);
	const member = access("c0-3", "club", ["u3", "u4"]);
	const family = access("f0-1", "family", []);
	const guest = access("guest", "none", []);
	const tiny = access("t0", "club", ["tiny"]);
	const timed = async (what: string, budget: number, read: () => Promise<unknown>): Promise<void> => {
		const times: number[] = [];
		for (let run = 0; run < 400; run++) {
			const start = performance.now();
			await read();
			times.push(performance.now() - start);
		}
		expectAtMost(what, median(times.slice(100)), budget, "ms");
	};
	const { sessions, teams, shares } = app;
	await timed("a family member's list, the rule's source (dense)", 2, () =>
		sessions.visible.page({ app: "family", condition: family.rule }, PAGE, context),
	);
	await timed("the team page, T = 300, ordered by the sessions' last touch", 2, () =>
		teams.ofTeams.page({ teams: ["u3"], condition: member.condition }, PAGE, context),
	);
	await timed("a club member's list, the teams' source (two teams, 600 rows)", 2, () =>
		teams.ofTeams.page({ teams: ["u3", "u4"], condition: member.condition }, PAGE, context),
	);
	await timed("a club member's list, the source of what they created", 2, () =>
		sessions.createdBy.page(
			{ app: "club", person: "p7", condition: access("p7", "club", ["u3"]).condition },
			PAGE,
			context,
		),
	);
	await timed("sparse: a guest with 2 shares among 3,000", 0.2, () =>
		shares.sessionsOf.page({ person: "guest", app: "family", condition: guest.condition }, PAGE, context),
	);
	await timed("sparse: a member of one team of 20 in a club of 3,000", 0.2, () =>
		teams.ofTeams.page({ teams: ["tiny"], condition: tiny.condition }, PAGE, context),
	);
	await timed("a sidebar's active list, a club member", 2, () =>
		sessions.inStates.page({ states: ACTIVE, condition: member.condition }, PAGE, context),
	);
	await timed("a sidebar's recent list, a club member", 2, () =>
		sessions.since.page({ since: SINCE, condition: member.condition }, PAGE, context),
	);
	await timed("a sidebar's active list, the guest", 2, () =>
		sessions.inStates.page({ states: ACTIVE, condition: guest.condition }, PAGE, context),
	);
	await close();
}

const COUNTERS = ["chord.query.runs", "chord.query.probes", "chord.query.skips"];
/** The counters now, for `delta`. */
function names3(mix: { counter(name: string): number }): number[] {
	return COUNTERS.map(mix.counter);
}
/** How much the counters grew since `before`: runs, probes, skips. */
function delta(mix: { counter(name: string): number }, before: readonly number[]): number[] {
	return COUNTERS.map((name, index) => mix.counter(name) - before[index]!);
}

/** Touches `club-3` `times` times and resolves with the median time of the call and the counters of one touch. */
async function touched(mix: Awaited<ReturnType<typeof mixed>>, times: number) {
	const names = ["chord.query.runs", "chord.query.probes", "chord.query.skips"];
	const durations: number[] = [];
	let counts: number[] = [];
	for (let run = 0; run < times; run++) {
		const before = names.map(mix.counter);
		const start = performance.now();
		await mix.app.touch(
			{ id: "club-3", at: 30_000 + run, state: run % 2 === 0 ? "waiting" : "working" },
			mix.context,
		);
		durations.push(performance.now() - start);
		counts = names.map((name, index) => mix.counter(name) - before[index]!);
	}
	const [runs, probes, skips] = counts;
	return { ms: median(durations.slice(Math.floor(times / 4))), runs: runs!, probes: probes!, skips: skips! };
}

console.log("\nslice 14, §9: a touch of a club session at the mix");
{
	const mix = await mixed(1);
	const quiet = await mixed(0);
	const baseline = (await touched(quiet, 400)).ms;
	await quiet.close();
	const touch = await touched(mix, 400);
	console.log(`  ${mix.reads} reads open; a touch with no read open takes ${baseline.toFixed(3)} ms`);
	expectExactly("runs a touch causes", touch.runs, 9);
	// The commit index (slice 15 §3) leaves out the 41 reads whose bucket the touched row is not in (another app's
	// lists, other teams' pages): no candidates, so no skip test and none of their probes (101 and 185 before it).
	expectExactly("keyed probes a touch causes", touch.probes, 79);
	expectExactly("reads a touch skips", touch.skips, mix.reads - 9 - 41);
	expectAtMost("an ordinary commit, every re-run included", touch.ms, 5, "ms");

	// A probe: a touch of a session only probes ask about (archived elsewhere: shown by nobody).
	const probing = async (run: number): Promise<number> => {
		const start = performance.now();
		await mix.app.touch({ id: "old-7", at: 40_000 + run, state: "idle" }, mix.context);
		return performance.now() - start;
	};
	const probed = names3(mix);
	const times: number[] = [];
	for (let run = 0; run < 400; run++) times.push(await probing(run));
	const [probeRuns, probes] = delta(mix, probed);
	console.log(`  a touch of a session nobody shows: ${probeRuns! / 400} runs and ${probes! / 400} probes per touch`);
	expectAtMost("a probe", (median(times.slice(100)) - baseline) / (probes! / 400), 0.02, "ms");

	// A write to another session: the worker following its own session runs nothing.
	const names = ["chord.query.runs", "chord.query.probes"];
	const before = names.map(mix.counter);
	await mix.app.touch({ id: "family-2999", at: 2, state: "idle" }, mix.context);
	const [runs] = names.map((name, index) => mix.counter(name) - before[index]!);
	expectExactly("runs a touch of a session nobody shows causes", runs!, 0);

	// An archive assigns a condition column of the counts: the 21 team counts run (reported, no budget).
	const archived = names.map(mix.counter);
	const start = performance.now();
	await mix.app.archive({ id: "club-13", at: 5 }, mix.context);
	const took = performance.now() - start;
	const [archiveRuns, archiveProbes] = names.map((name, index) => mix.counter(name) - archived[index]!);
	console.log(
		`  reported: an archive of a club session: ${archiveRuns} runs, ${archiveProbes} probes, ${took.toFixed(3)} ms`,
	);
	await mix.close();
}

console.log("\nslice 14, §9: reported without a budget: the same touch at ten times the mix");
{
	const mix = await mixed(10);
	const touch = await touched(mix, 100);
	console.log(`  ${mix.reads} reads open: ${touch.runs} runs, ${touch.probes} probes, ${touch.ms.toFixed(3)} ms`);
	await mix.close();
}

console.log("\nslice 14, §9: a session's 5,000 subagents (a list by last touch, 20 pages loaded)");
{
	const ChildRows = defineTable("child-rows", {
		version: 1,
		columns: { id: int(), session: str(), lastTouch: int() },
		key: ["id"],
		indexes: { of_session: ["session", "lastTouch"] },
	});
	const Child = obj({ id: int(), lastTouch: int() });
	const Children = local("bench.children", {
		version: 1,
		params: {},
		members: {
			children: queries(Child, { ofSession: obj({ session: str() }) }),
			spawn: method(int()),
			message: method(obj({ id: int(), at: int() })),
		},
	});
	const Subagents = local("bench.subagents", {
		version: 1,
		// One list object per screen: it activates when the screen holds it.
		params: { view: str() },
		members: { list: obj({ rows: arr(Child), moreAfter: bool() }), more: method() },
	});
	const facet = defineFacet((h) => {
		h.serve(Children, (_, self) => {
			const rows = self.table(ChildRows);
			return {
				children: self.queries(
					rows,
					{ map: ({ id, lastTouch }) => ({ id, lastTouch }), reads: ["id", "lastTouch"] },
					{
						ofSession: ({ session }: { session: string }) =>
							query(ChildRows)
								.where((c) => eq(c.session, session))
								.orderBy((c) => c.lastTouch, "desc"),
					},
				),
				spawn: async (count, ctx) => {
					await self.tx(async (tx) => {
						for (let id = 1; id <= count; id++) tx.put(rows, { id, session: "s", lastTouch: id });
					}, ctx);
					return null;
				},
				message: async ({ id, at }, ctx) => {
					await self.tx(async (tx) => tx.update(rows, { id }, { lastTouch: at }), ctx);
					return null;
				},
			};
		});
		h.serve(Subagents, (_, self) => {
			const list = self.list("children", [[self.get(Children, {}).children.ofSession, { session: "s" }]], {
				first: PAGE,
			});
			return { list: list.value, more: (ctx) => list.more(ctx) };
		});
	});
	const telemetry = new InMemoryTelemetryContext();
	const context = withTelemetry(await telemetry.startSpan({ name: "bench" }, (span) => span), BACKGROUND_CONTEXT);
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const host = createHost({ store, telemetry, onError: (error) => console.error(error) });
	await host.load([{ name: "@bench/children", facet }], context);
	const children = await host.get(Children, {}, context);
	await children.spawn(5_000, context);
	const opened = performance.now();
	const screen = await host.get(Subagents, { view: "tab" }, context);
	expectAtMost(
		"the first page of 50 of 5,000 (the object's activation included)",
		performance.now() - opened,
		2,
		"ms",
	);
	for (let page = 1; page < 20; page++) await screen.more(context);
	expectExactly("rows loaded by 20 pages", screen.list.value.rows.length, 20 * PAGE);
	const counter = (name: string): number =>
		telemetry
			.getMetrics()
			.filter((metric) => metric.name === name)
			.reduce((sum, metric) => sum + metric.value, 0);
	// A message to a child in the middle of what is loaded: it leaves its page and enters the first one.
	const times: number[] = [];
	let runs = 0;
	let at = 10_000;
	for (let message = 0; message < 400; message++) {
		const id = screen.list.value.rows[500]!.id;
		const before = counter("chord.query.runs");
		const start = performance.now();
		await children.message({ id, at: ++at }, context);
		times.push(performance.now() - start);
		runs = counter("chord.query.runs") - before;
	}
	expectExactly("runs a message causes (the page the child left, the first page)", runs, 2);
	expectAtMost("a message: one child to the top, 20 pages loaded", median(times.slice(100)), 5, "ms");
	// 10,000 touches of loaded children: the pages they leave and enter split and merge, and stay bounded.
	for (let touch = 0; touch < 10_000; touch++) {
		const rows = screen.list.value.rows;
		await children.message({ id: rows[(touch * 37) % rows.length]!.id, at: ++at }, context);
	}
	// The store's index of reads is the store's own surface, not an app's.
	const pages = (store as ChordStore).reads.on("bench.children:child-rows")?.size ?? 0;
	const loaded = screen.list.value.rows.length;
	console.log(`  after 10,000 touches: ${loaded} rows loaded in ${pages} pages`);
	expectAtMost("pages for the loaded rows after 10,000 touches", pages, (2 * loaded) / PAGE + 1, "pages");
	screen.release();
	children.release();
	await host.close(context);
	await store.close(context);
}

if (failures.length > 0) {
	console.log(`\nMISSED: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("\nall of §9's numbers for the built parts are met");
