// Column sets, `exists` and the one-to-one join (slice 14 §5, §6): a plugin's contract file declares the columns of
// one of its tables that other plugins may read (`defineColumns`), and its table says so (`exposes`). Another
// plugin's query may then test `exists` in that set, or join one row of it by its key. Two tables are matched only by
// equality to a key or a declared index. A condition can be handed over as data (`compile`, `whereNode`): here "what
// a person may see" is built once and applied by a store that does not know the rule. A commit of either owner
// reaches the reads over its table; a keyed probe decides whether a read must run again.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/72-exists-and-joins.ts
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, withTelemetry } from "../../src/context/index.ts";
import { arr, bool, int, local, method, obj, queries, str, unknown } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import {
	and,
	compile,
	defineColumns,
	defineTable,
	eq,
	exists,
	inArray,
	openStore,
	or,
	query,
	sqliteBackend,
	type WhereNode,
} from "../../src/store/index.ts";

// The sessions plugin's contract file: the columns others may use, and the key they match by. No versions: the
//    columns a read uses are checked by name and type when it opens.
const SessionColumns = defineColumns("example.session-columns", {
	columns: { id: str(), app: str(), title: str(), creator: str(), lastTouch: int() },
	key: ["id"],
});
const SessionItem = obj({ id: str(), title: str(), lastTouch: int() });
const Sessions = local("example.sessions", {
	version: 1,
	params: {},
	members: {
		// The condition arrives as data: built by server code, checked whole before anything is rendered.
		sessions: queries(SessionItem, { visible: obj({ app: str(), condition: unknown() }) }),
		put: method(obj({ id: str(), app: str(), title: str(), creator: str() })),
		touch: method(str()),
	},
});

// Its server file: the table spreads the public columns in and says so. `cwd` stays private.
const SessionRows = defineTable("example.session-rows", {
	version: 1,
	columns: { ...SessionColumns.columns, cwd: str({ default: "/" }) },
	key: ["id"],
	indexes: { by_app: ["app", "lastTouch"] },
	exposes: SessionColumns,
});

let clock = 0;
const sessionsFacet = defineFacet((h) =>
	h.serve(Sessions, (_, self) => {
		const rows = self.table(SessionRows);
		return {
			sessions: self.queries(
				rows,
				{ map: ({ id, title, lastTouch }) => ({ id, title, lastTouch }), reads: ["id", "title", "lastTouch"] },
				{
					// A builder's arguments are annotated by hand: returning the handle as the contract's member checks
					// them against the schema the contract lists.
					visible: ({ app, condition }: { app: string; condition: unknown }) =>
						query(SessionRows)
							.where((s) => eq(s.app, app))
							.whereNode(SessionColumns, condition)
							.orderBy((s) => s.lastTouch, "desc"),
				},
			),
			put: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(rows, { ...row, lastTouch: ++clock }), ctx);
				return null;
			},
			// A touch names what it changes: the readers that depend on none of it skip for free.
			touch: async (id, ctx) => {
				await self.tx(async (tx) => tx.update(rows, { id }, { lastTouch: ++clock }), ctx);
				return null;
			},
		};
	}),
);

// The club plugin: which session is in which team. Its side table is a column set too, with the index others
//    match by.
const TeamSessions = defineColumns("example.team-sessions", {
	columns: { team: str(), session: str() },
	key: ["team", "session"],
	indexes: { ofSession: ["session"] },
});
const TeamRows = defineTable("example.team-rows", {
	version: 1,
	columns: { ...TeamSessions.columns },
	key: ["team", "session"],
	indexes: { of_session: ["session"] },
	exposes: TeamSessions,
});
const Club = local("example.club", {
	version: 1,
	params: {},
	members: {
		teams: queries(SessionItem, { ofTeam: obj({ team: str(), condition: unknown() }) }),
		add: method(obj({ team: str(), session: str() })),
	},
});

const clubFacet = defineFacet((h) =>
	h.serve(Club, (_, self) => {
		const rows = self.table(TeamRows);
		return {
			teams: self.queries(
				rows,
				{
					// The mapping gets the team row (no column of it: `reads: []`) and its session's projected columns.
					map: (_row, session) => ({
						id: session.id as string,
						title: session.title as string,
						lastTouch: session.lastTouch as number,
					}),
					reads: [],
					partnerReads: ["id", "title", "lastTouch"],
				},
				{
					// The team page: driven from the team's rows (key (team, session)), one session per row by its key,
					// ordered by the sessions' last touch. The person's condition applies on the joined side: a stale
					// team row grants nothing.
					ofTeam: ({ team, condition }: { team: string; condition: unknown }) =>
						query(TeamRows)
							.where((t) => eq(t.team, team))
							.join(SessionColumns, (t) => ({ id: t.session }))
							.where((_t, session) => eq(session.app, "club"))
							.whereNode(SessionColumns, condition)
							.orderBy((_t, session) => session.lastTouch, "desc"),
				},
			),
			add: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(rows, row), ctx);
				return null;
			},
		};
	}),
);

// What a person may see, as a condition over the sessions' columns: the family's sessions they created, and the
//    club's sessions of their teams. Server code builds it; `compile` makes it plain data.
function conditionOf(person: string, teams: readonly string[]): WhereNode {
	const s = SessionColumns.refs;
	return compile(
		SessionColumns,
		or(
			and(eq(s.app, "family"), eq(s.creator, person)),
			and(
				eq(s.app, "club"),
				exists(TeamSessions, { session: s.id }, (t) => inArray(t.team, teams)),
			),
		),
	);
}

// A person's screens: the club's sessions they see (an `exists`), and their team's page (a join).
const Screens = local("example.screens", {
	version: 1,
	params: { person: str(), team: str() },
	members: {
		club: obj({ rows: arr(SessionItem), more: bool() }),
		team: obj({ rows: arr(SessionItem), more: bool() }),
		size: int(),
	},
});
const screensFacet = defineFacet((h) =>
	h.serve(Screens, ({ person, team }, self) => {
		const condition = conditionOf(person, [team]);
		const ofTeam = self.get(Club, {}).teams.ofTeam;
		return {
			club: self.liveQuery(self.get(Sessions, {}).sessions.visible, { app: "club", condition }, { first: 10 }),
			team: self.liveQuery(ofTeam, { team, condition }, { first: 10 }),
			// A count over what a key bounds: the team's rows.
			size: self.count(ofTeam, { team, condition }),
		};
	}),
);

const telemetry = new InMemoryTelemetryContext();
const context = withTelemetry(await telemetry.startSpan({ name: "example" }, (span) => span), BACKGROUND_CONTEXT);
const counter = (name: string): number =>
	telemetry
		.getMetrics()
		.filter((metric) => metric.name === name)
		.reduce((sum, metric) => sum + metric.value, 0);
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const host = createHost({ store, telemetry, onError: (error) => console.error(error) });
await host.load(
	[
		{ name: "@example/sessions", facet: sessionsFacet },
		{ name: "@example/club", facet: clubFacet },
		{ name: "@example/screens", facet: screensFacet },
	],
	context,
);
const sessions = await host.get(Sessions, {}, context);
const club = await host.get(Club, {}, context);

for (const [id, app, team] of [
	["s1", "club", "u12"],
	["s2", "club", "u12"],
	["s3", "club", "u14"],
	["s4", "family", undefined],
] as const) {
	await sessions.put({ id, app, title: `session ${id}`, creator: "anna" }, context);
	if (team !== undefined) await club.add({ team, session: id }, context);
}

// 1. Two persons' screens over the same rows: each sees its team's sessions.
const anna = await host.get(Screens, { person: "anna", team: "u12" }, context);
const ben = await host.get(Screens, { person: "ben", team: "u14" }, context);
const ids = (list: { rows: { id: string }[] }): string => list.rows.map((row) => row.id).join(" ");
console.log(
	"1. anna (u12): club:",
	ids(anna.club.value),
	"| team page:",
	ids(anna.team.value),
	"| size:",
	anna.size.value,
);
console.log(
	"   ben (u14):  club:",
	ids(ben.club.value),
	"| team page:",
	ids(ben.team.value),
	"| size:",
	ben.size.value,
);

// 2. A touch of s1 (anna's team). Six reads are open. Anna's two lists show s1 and run; ben's ask one keyed probe
//    each ("does s1 pass this read's condition, in its range?") and skip; the counts depend on no touched column.
const cost = async (what: string, write: () => Promise<unknown>): Promise<void> => {
	const names = ["chord.query.runs", "chord.query.probes", "chord.query.skips"];
	const before = names.map(counter);
	await write();
	const [runs, probes, skips] = names.map((name, index) => counter(name) - before[index]!);
	console.log(`${what}: ${runs} runs, ${probes} probes, ${skips} skipped`);
};
await cost("2. a touch of s1 costs the six open reads", () => sessions.touch("s1", context));
console.log("   anna's team page:", ids(anna.team.value));

// 3. The club adds s3 to u12: a commit of the other owner. Every read runs: s3 is among the rows ben's lists show
//    (a team row of it may change what their condition says), anna's lists gain it, and a count keeps no rows.
await cost("3. s3 joins u12", () => club.add({ team: "u12", session: "s3" }, context));
console.log("   anna: club:", ids(anna.club.value), "| team page:", ids(anna.team.value), "| size:", anna.size.value);

// 4. The bounding rule: tables are matched by a set's key, a leading prefix of it or a declared index (`session`
//    alone is the declared index `ofSession`; `team` alone a prefix of the key), and by nothing else.
query(SessionRows).where((s) => exists(TeamSessions, { session: s.id }));
query(TeamRows).where((t) => exists(TeamSessions, { team: t.team }));
try {
	const Notes = defineColumns("example.notes", { columns: { id: str(), session: str() }, key: ["id"] });
	query(SessionRows).where((s) => exists(Notes, { session: s.id }));
} catch (error) {
	console.log("4. refused:", (error as Error).message);
}

anna.release();
ben.release();
sessions.release();
club.release();
await host.close(context);
await store.close(context);
