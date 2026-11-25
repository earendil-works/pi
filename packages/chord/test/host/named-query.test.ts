// Named queries (slice 14 §3.1, §5, test list 2, 7, 11, 18): what `self.queries` returns implements a `queries`
// member; a joined query's mapping gets the row and its partner, projected; `page` reads without a live read; the
// member check and staging; and a column set's binding across its publisher's reloads: unchanged code, a migration,
// a used column dropped, the set no longer exposed and exposed again, two tables exposing one name. And a reference's
// named queries, made on first use (slice 15 §5).

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, hostKind, int, local, method, obj, opt, queries, str } from "../../src/contracts/index.ts";
import { currentVersion } from "../../src/contracts/internal.ts";
import {
	createHost,
	defineFacet,
	type FacetHost,
	type Host,
	type HostError,
	type StoreSelf,
} from "../../src/host/index.ts";
import { ownQueries, type ReferenceQuery } from "../../src/host/named-query.ts";
import { defineColumns } from "../../src/store/column-set.ts";
import { eq, exists } from "../../src/store/expression.ts";
import { host as hostColumn } from "../../src/store/host-column.ts";
import { query } from "../../src/store/query.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { evolveTable } from "../../src/store/table-evolve.ts";
import { changesOf, delivered, expectCollected, failures, flushed, memoryStore, metered } from "../support.ts";

const Session = hostKind("session", { id: str() });
const SessionColumns = defineColumns("sessions.columns", {
	columns: { id: hostColumn(Session), app: str(), title: str(), lastTouch: int() },
	key: ["id"],
});
const Rows = defineTable("rows", {
	version: 1,
	columns: { ...SessionColumns.columns, cwd: str({ default: "/" }) },
	key: ["id"],
	exposes: SessionColumns,
});
const Sessions = local("app.sessions", {
	version: 1,
	params: {},
	members: {
		put: method(obj({ id: str(), app: str(), title: str(), lastTouch: int() })),
		touch: method(obj({ id: str(), at: int() })),
	},
});

const TeamRows = defineTable("team-rows", {
	version: 1,
	columns: { team: str(), session: hostColumn(Session) },
	key: ["team", "session"],
});
const TeamItem = obj({ session: str(), title: str(), touched: int() });
const Club = local("app.club", {
	version: 1,
	params: {},
	members: {
		teams: queries(TeamItem, { ofTeam: obj({ team: str() }) }),
		add: method(obj({ team: str(), session: str() })),
	},
});
const TeamPage = local("app.team-page", {
	version: 1,
	params: { team: str() },
	members: { sessions: obj({ rows: arr(TeamItem), more: bool() }) },
});

/**
 * The sessions' store: the publisher of the column set. `table` is the version its code declares; `declare` adds
 * what a test needs of its factory (a native).
 */
function serveSessions(h: FacetHost, table: typeof Rows = Rows, declare: (self: StoreSelf) => void = () => {}): void {
	h.serve(Sessions, (_, self) => {
		declare(self);
		const rows = self.table(table);
		return {
			put: async ({ id, ...rest }, ctx) => {
				await self.tx(async (tx) => tx.put(rows, { id: Session({ id }), ...rest }), ctx);
				return null;
			},
			touch: async ({ id, at }, ctx) => {
				await self.tx(async (tx) => tx.update(rows, { id: Session({ id }) }, { lastTouch: at }), ctx);
				return null;
			},
		};
	});
}

/** What the club's mapping was handed, by call. */
type Probe = { partners: string[][] };

/** The club: its team rows joined with the sessions' column set, and a page per team. */
function serveClub(
	h: FacetHost,
	probe: Probe = { partners: [] },
	set = SessionColumns,
	sessionsOf: (self: StoreSelf, team: string) => unknown = (self, team) =>
		self.liveQuery(self.get(Club, {}).teams.ofTeam, { team }, { first: 10 }),
): void {
	h.serve(Club, (_, self) => {
		const table = self.table(TeamRows);
		return {
			teams: self.queries(
				table,
				{
					map: (row, session) => {
						probe.partners.push(Object.keys(session).sort());
						return {
							session: row.session.params.id,
							title: session.title as string,
							touched: session.lastTouch as number,
						};
					},
					partnerReads: ["title", "lastTouch"],
				},
				{
					ofTeam: ({ team }: { team: string }) =>
						query(TeamRows)
							.where((t) => eq(t.team, team))
							.join(set, (t) => ({ id: t.session }))
							.where((_t, session) => eq(session.app, "club"))
							.orderBy((_t, session) => session.lastTouch, "desc"),
				},
			),
			add: async ({ team, session }, ctx) => {
				await self.tx(async (tx) => tx.put(table, { team, session: Session({ id: session }) }), ctx);
				return null;
			},
		};
	});
	// The page's read is the test's to declare wrongly (staging): plugin code is bundled without type checks.
	h.serve(TeamPage, (({ team }: { team: string }, self: StoreSelf) => ({
		sessions: sessionsOf(self, team),
	})) as never);
}

/** A plugin of a test host. */
type Plugin = { readonly name: string; readonly facet: ReturnType<typeof defineFacet> };

/** The sessions' plugin at a table version: only the publisher's code changes in these reloads. */
const publisher = (table = Rows): Plugin => ({
	name: "@test/sessions",
	facet: defineFacet((h) => serveSessions(h, table)),
});

/** A host with both plugins, three sessions (two of the club) and a team of the first two. */
async function hosted(
	store: ChordStore,
	probe?: Probe,
): Promise<{ readonly host: Host; readonly errors: HostError[]; readonly club: Plugin }> {
	const errors: HostError[] = [];
	const host = createHost({ store, onError: (error) => errors.push(error) });
	const club: Plugin = { name: "@test/club", facet: defineFacet((h) => serveClub(h, probe)) };
	await host.load([publisher(), club], context);
	const sessions = await host.get(Sessions, {}, context);
	const teams = await host.get(Club, {}, context);
	for (const [index, app] of ["club", "club", "family"].entries()) {
		await sessions.put({ id: `s${index}`, app, title: `t${index}`, lastTouch: index }, context);
		await teams.add({ team: "u12", session: `s${index}` }, context);
	}
	return { host, errors, club };
}

describe("a joined named query", () => {
	it("maps each row with its partner's projected columns, in the partner's order", async () => {
		const store = await memoryStore();
		const probe: Probe = { partners: [] };
		const { host } = await hosted(store, probe);
		const page = await host.get(TeamPage, { team: "u12" }, context);
		// The family's session is no club session: its team row is dropped.
		expect(page.sessions.value.rows).toEqual([
			{ session: "s1", title: "t1", touched: 1 },
			{ session: "s0", title: "t0", touched: 0 },
		]);
		expect(probe.partners.at(-1)).toEqual(["lastTouch", "title"]);
		// The sessions' owner commits: the club's read over its table runs in that owner's step.
		await (await host.get(Sessions, {}, context)).touch({ id: "s0", at: 9 }, context);
		expect(page.sessions.value.rows.map((row) => row.session)).toEqual(["s0", "s1"]);
		await host.close(context);
		await store.close(context);
	});

	it("reads a page at a time without a live read", async () => {
		const store = await memoryStore();
		const { host } = await hosted(store);
		const club = await host.get(Club, {}, context);
		const first = await club.teams.ofTeam.page({ team: "u12" }, 1, context);
		expect(first.items).toEqual([{ session: "s1", title: "t1", touched: 1 }]);
		const second = await club.teams.ofTeam.page({ team: "u12" }, 1, context, { after: first.next! });
		expect([second.items.map((item) => item.session), second.next]).toEqual([["s0"], undefined]);
		await expect(club.teams.ofTeam.page({ team: "u12" }, 1, context, { after: "nope" })).rejects.toMatchObject({
			code: "invalid",
			reason: "args",
		});
		await host.close(context);
		await store.close(context);
	});
});

describe("the member check", () => {
	/** The failure of an attempt of `Club` whose factory returns `teams` for its `queries` member. */
	async function broken(teams: (self: StoreSelf) => unknown): Promise<string[]> {
		const store = await memoryStore();
		const errors: HostError[] = [];
		const host = createHost({ store, onError: (error) => errors.push(error) });
		const facet = defineFacet((h) => {
			// Plugin code is bundled without type checks: a wrong member reaches the member check.
			h.serve(Club, ((_: unknown, self: StoreSelf) => ({ teams: teams(self), add: async () => null })) as never);
		});
		await host.load([{ name: "@test/club", facet }], context);
		await host.get(Club, {}, context).catch(() => {});
		await host.close(context);
		await store.close(context);
		return errors.map((error) =>
			error.kind === "activation_failed" || error.kind === "object_failed"
				? error.failure.error.message
				: error.kind,
		);
	}

	it("refuses anything but what self.queries returned, a listed query without a builder, and a second schema", async () => {
		expect(await broken(() => ({}))).toEqual([
			expect.stringContaining('teams: no builder for the listed query "ofTeam"'),
		]);
		expect(await broken(() => 5)).toEqual([
			expect.stringContaining("teams: a queries member is what self.queries returned"),
		]);
		const twice = await broken((self) =>
			self.queries(
				self.table(TeamRows),
				{ map: () => null },
				{ ofTeam: [obj({ team: str() }), (_args: { team: string }) => query(TeamRows)] },
			),
		);
		expect(twice).toEqual([expect.stringContaining("the contract has its argument schema; give only the builder")]);
	});
});

describe("a column set across its publisher's reloads", () => {
	it("unchanged code and an unused column added: no reader restarts, equal rows send nothing", async () => {
		const store = await memoryStore();
		const { host, errors, club } = await hosted(store);
		const page = await host.get(TeamPage, { team: "u12" }, context);
		const watch = await page.sessions.watch(context);
		const calls = changesOf(watch);
		await host.reload([publisher(), club], context);
		await flushed();
		const Wider = evolveTable(Rows, (t) => t.add("note", opt(str())));
		await host.reload([publisher(Wider as unknown as typeof Rows), club], context);
		await flushed();
		await delivered();
		expect(calls.map((call) => (call.kind === "failed" ? String(call.error) : call.kind))).toEqual([]);
		expect(failures(errors)).toEqual([]);
		// The migrated table still feeds the reader.
		await (await host.get(Sessions, {}, context)).touch({ id: "s0", at: 9 }, context);
		await delivered();
		expect(page.sessions.value.rows.map((row) => row.session)).toEqual(["s0", "s1"]);
		expect(calls).toHaveLength(1);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});

	it("a used column dropped fails exactly the reads using it, before any SQL; restored, they heal", async () => {
		const store = await memoryStore();
		const { host, club } = await hosted(store);
		const page = await host.get(TeamPage, { team: "u12" }, context);
		const watch = await page.sessions.watch(context);
		const calls = changesOf(watch);
		const Narrow = defineColumns("sessions.columns", {
			columns: { id: hostColumn(Session), app: str(), lastTouch: int() },
			key: ["id"],
		});
		const Dropped = evolveTable(Rows, (t) => t.drop("title"), { exposes: Narrow });
		await host.reload([publisher(Dropped as unknown as typeof Rows), club], context);
		await flushed();
		await delivered();
		expect(calls.map((call) => (call.kind === "failed" ? (call.error as Error).message : call.kind))).toEqual([
			'column "title" of column set "sessions.columns" is not what this read was written for',
		]);
		// The store is usable: another owner still commits. Restored, the read heals.
		await (await host.get(Club, {}, context)).add({ team: "u14", session: "s0" }, context);
		const Restored = evolveTable(Dropped, (t) => t.add("title", str({ default: "restored" })), {
			exposes: SessionColumns,
		});
		await host.reload([publisher(Restored as unknown as typeof Rows), club], context);
		await flushed();
		await delivered();
		expect(page.sessions.value.rows.map((row) => row.title)).toEqual(["restored", "restored"]);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});

	it("a set exposed no more is not served; two tables exposing one name are refused, naming both", async () => {
		const store = await memoryStore();
		const { host, errors, club } = await hosted(store);
		const page = await host.get(TeamPage, { team: "u12" }, context);
		const Hidden = evolveTable(Rows, (t) => t.add("note", opt(str())), { exposes: "none" });
		await host.reload([publisher(Hidden as unknown as typeof Rows), club], context);
		await flushed();
		expect(() => page.sessions.value).toThrow('column set "sessions.columns" is not served');
		const Exposed = evolveTable(Hidden, (t) => t.add("more", opt(str())), { exposes: SessionColumns });
		await host.reload([publisher(Exposed as unknown as typeof Rows), club], context);
		await flushed();
		expect(page.sessions.value.rows.map((row) => row.session)).toEqual(["s1", "s0"]);
		// Another owner exposing the same name: its activation fails, the binding stays.
		const Thief = local("app.thief", { version: 1, params: {}, members: { n: int() } });
		const Stolen = defineTable("stolen", {
			version: 1,
			columns: { ...SessionColumns.columns },
			key: ["id"],
			exposes: SessionColumns,
		});
		const thief = defineFacet((h) => {
			h.serve(Thief, (_, self) => {
				self.table(Stolen);
				return { n: self.derive([], () => 1) };
			});
		});
		const exposed = publisher(Exposed as unknown as typeof Rows);
		await host.reload([exposed, club, { name: "@test/thief", facet: thief }], context);
		await host.get(Thief, {}, context).catch(() => {});
		expect(failures(errors).at(-1)).toContain("app.thief: broken");
		expect(errors.at(-1)).toMatchObject({
			failure: {
				error: { message: expect.stringContaining('exposed by tables "app.sessions:rows" and "app.thief:stolen"') },
			},
		});
		expect(page.sessions.value.rows).toHaveLength(2);
		await host.close(context);
		await store.close(context);
	});
});

describe("the mapping's projection", () => {
	it("gets only the columns reads and partnerReads list, also when the query orders or matches by others", async () => {
		// Review round 1 (Sol 7): the statement selects the key, the order and the match columns for the store; the
		// mapping does not see them.
		const store = await memoryStore();
		const seen: string[][] = [];
		const Plain = defineTable("plain", {
			version: 1,
			columns: { id: int(), group: str(), text: str(), session: hostColumn(Session) },
			key: ["id"],
		});
		const Projected = local("app.projected", {
			version: 1,
			params: {},
			members: { rows: queries(obj({ text: str() }), { all: obj({}) }), put: method(int()) },
		});
		const host = createHost({ store, onError: () => {} });
		const projected = defineFacet((h) => {
			h.serve(Projected, (_, self) => {
				const table = self.table(Plain);
				return {
					rows: self.queries(
						table,
						{
							map: (row, session) => {
								seen.push([...Object.keys(row).sort(), "|", ...Object.keys(session).sort()]);
								return { text: row.text };
							},
							reads: ["text"],
							partnerReads: ["title"],
						},
						{
							all: (_args: Record<string, never>) =>
								query(Plain)
									.join(SessionColumns, (row) => ({ id: row.session }))
									.orderBy((row) => row.group)
									.orderBy((_row, session) => session.lastTouch),
						},
					),
					put: async (id, ctx) => {
						const row = { id, group: "g", text: "t", session: Session({ id: "s0" }) };
						await self.tx(async (tx) => tx.put(table, row), ctx);
						return null;
					},
				};
			});
		});
		await host.load([publisher(), { name: "@test/projected", facet: projected }], context);
		const sessions = await host.get(Sessions, {}, context);
		await sessions.put({ id: "s0", app: "club", title: "t0", lastTouch: 1 }, context);
		const rows = await host.get(Projected, {}, context);
		await rows.put(1, context);
		expect((await rows.rows.all.page({}, 5, context)).items).toEqual([{ text: "t" }]);
		expect(seen).toEqual([["text", "|", "title"]]);
		await host.close(context);
		await store.close(context);
	});
});

describe("bindings across reloads (code review round 1)", () => {
	it("a publisher whose new code declares no table serves its set no more", async () => {
		// Sol 2, Astra S1: the binding must not outlive the last table.
		const store = await memoryStore();
		const { host, club } = await hosted(store);
		const page = await host.get(TeamPage, { team: "u12" }, context);
		const bare = defineFacet((h) => {
			h.serve(Sessions, () => ({ put: async () => null, touch: async () => null }));
		});
		await host.reload([{ name: "@test/sessions", facet: bare }, club], context);
		await flushed();
		expect(store.reads.get(SessionColumns.name)).toBeUndefined();
		expect(() => page.sessions.value).toThrow('column set "sessions.columns" is not served');
		await host.close(context);
		await store.close(context);
	});

	it("a set moved to another plugin's table in one reload is bound to the new table", async () => {
		// Opus S6, round 2 S3: the old owner's binding goes at its seal, not at the end of its teardown. Its native's
		// close ends only when the new owner is live, so its teardown is still running when the new owner binds.
		const store = await memoryStore();
		const { host, club } = await hosted(store);
		const page = await host.get(TeamPage, { team: "u12" }, context);
		const closing = Promise.withResolvers<void>();
		const slow = defineFacet((h) =>
			serveSessions(h, Rows, (self) => {
				self.open(
					async () => null,
					() => closing.promise,
				);
			}),
		);
		await host.reload([{ name: "@test/sessions", facet: slow }, club], context);
		await host.get(Sessions, {}, context);
		const Moved = local("app.moved", { version: 1, params: {}, members: { put: method(str()) } });
		const MovedRows = defineTable("moved-rows", {
			version: 1,
			columns: { ...SessionColumns.columns },
			key: ["id"],
			exposes: SessionColumns,
		});
		const moved = defineFacet((h) => {
			h.serve(Moved, (_, self) => {
				const rows = self.table(MovedRows);
				return {
					put: async (id, ctx) => {
						const row = { id: Session({ id }), app: "club", title: "moved", lastTouch: 5 };
						await self.tx(async (tx) => tx.put(rows, row), ctx);
						return null;
					},
				};
			});
		});
		// The sessions' plugin is gone, another plugin exposes the set from its own table.
		const report = await host.reload([club, { name: "@test/moved", facet: moved }], context);
		expect(report.failed).toEqual([]);
		const rows = await host.get(Moved, {}, context);
		closing.resolve();
		await rows.put("s0", context);
		await flushed();
		expect(store.reads.get(SessionColumns.name)?.table).toBe("app.moved:moved-rows");
		expect(page.sessions.value.rows).toEqual([{ session: "s0", title: "moved", touched: 5 }]);
		await host.close(context);
		await store.close(context);
	});

	it("two tables of one object exposing one set are refused where they are declared, naming both", async () => {
		const store = await memoryStore();
		const errors: HostError[] = [];
		const host = createHost({ store, onError: (error) => errors.push(error) });
		const Twice = local("app.twice", { version: 1, params: {}, members: { n: int() } });
		const Second = defineTable("second", {
			version: 1,
			columns: { ...SessionColumns.columns },
			key: ["id"],
			exposes: SessionColumns,
		});
		const facet = defineFacet((h) => {
			h.serve(Twice, (_, self) => {
				self.table(Rows);
				self.table(Second);
				return { n: self.derive([], () => 1) };
			});
		});
		await host.load([{ name: "@test/twice", facet }], context);
		await host.get(Twice, {}, context).catch(() => {});
		expect(errors.at(-1)).toMatchObject({
			failure: { error: { message: expect.stringContaining('is exposed by tables "rows" and "second"') } },
		});
		await host.close(context);
		await store.close(context);
	});
});

describe("a provider's restart under its readers (code review rounds 1 and 2)", () => {
	// A named query over a table that exposes nothing, whose condition tests another owner's set. The successor
	// renames a column the mapping reads, with a data step: a statement compiled for the table as it was fails
	// "no such column" from the migration's first commit on.
	const GateSet = defineColumns("gate.columns", { columns: { id: int() }, key: ["id"] });
	const Gate = defineTable("gate", { version: 1, columns: { ...GateSet.columns }, key: ["id"], exposes: GateSet });
	const Old = defineTable("texts", { version: 1, columns: { id: int(), text: str() }, key: ["id"] });
	const New = evolveTable(Old, (t) => t.rename("text", "renamed").rows(() => ({})));
	const Item = obj({ id: int(), text: str() });
	const Provider = local("app.provider", {
		version: 1,
		params: {},
		members: {
			rows: queries(Item, { all: obj({}) }),
			put: method(obj({ id: int(), text: str() })),
			/** As `put`, without waiting for its commit: a write that is no running call's. */
			later: method(obj({ id: int(), text: str() })),
		},
	});
	const Gates = local("app.gates", { version: 1, params: {}, members: { put: method(int()) } });
	const View = local("app.view", {
		version: 1,
		params: {},
		members: { items: obj({ rows: arr(Item), more: bool() }) },
	});
	const Screen = local("app.screen", {
		version: 1,
		params: {},
		members: { items: obj({ rows: arr(Item), moreAfter: bool() }), more: method() },
	});
	/** The old code's named queries, as each factory run declared them. */
	const declared: WeakRef<object>[] = [];

	const provider = (migrated: boolean): Plugin => ({
		name: "@test/provider",
		facet: defineFacet((h) => {
			h.serve(Provider, (_, self) => {
				if (migrated) {
					const table = self.table(New);
					return {
						rows: self.queries(
							table,
							{ map: (row) => ({ id: row.id, text: row.renamed }) },
							{
								all: (_args: Record<string, never>) => query(New).where((r) => exists(GateSet, { id: r.id })),
							},
						),
						put: async ({ id, text }, ctx) => {
							await self.tx(async (tx) => tx.put(table, { id, renamed: text }), ctx);
							return null;
						},
						later: async () => null,
					};
				}
				const table = self.table(Old);
				const rows = self.queries(
					table,
					{ map: (row) => ({ id: row.id, text: row.text }) },
					{ all: (_args: Record<string, never>) => query(Old).where((r) => exists(GateSet, { id: r.id })) },
				);
				declared.push(new WeakRef(ownQueries(rows)!.get("all")!));
				return {
					rows,
					put: async (row, ctx) => {
						await self.tx(async (tx) => tx.put(table, row), ctx);
						return null;
					},
					later: async (row) => {
						// The commit outlives the call: its context must not end with it.
						void self.tx(async (tx) => tx.put(table, row), context);
						return null;
					},
				};
			});
		}),
	});
	const others: Plugin = {
		name: "@test/others",
		facet: defineFacet((h) => {
			h.serve(Gates, (_, self) => {
				const table = self.table(Gate);
				return {
					put: async (id, ctx) => {
						await self.tx(async (tx) => tx.put(table, { id }), ctx);
						return null;
					},
				};
			});
			h.serve(View, (_, self) => ({ items: self.liveQuery(self.get(Provider, {}).rows.all, {}, { first: 10 }) }));
			h.serve(Screen, (_, self) => {
				const list = self.list("rows", [[self.get(Provider, {}).rows.all, {}]], { first: 1 });
				return { items: list.value, more: (ctx) => list.more(ctx) };
			});
		}),
	};

	/** A host with the old provider, rows 1 and 2 behind their gates, and `during` run once between the migration's commits. */
	async function hosted_(during: (gates: { put(id: number, ctx: typeof context): Promise<null> }) => Promise<void>) {
		declared.length = 0;
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		await host.load([provider(false), others], context);
		const gates = await host.get(Gates, {}, context);
		const rows = await host.get(Provider, {}, context);
		for (const [id, text] of [
			[1, "first"],
			[2, "second"],
		] as const) {
			await gates.put(id, context);
			await rows.put({ id, text }, context);
		}
		// The other owner acts once the table is recorded `migrating`: between the migration's commits.
		const commit = store.commit.bind(store);
		let ran = false;
		store.commit = async (writes, fence, ctx) => {
			const seq = await commit(writes, fence, ctx);
			if (!ran && store.table("app.provider:texts")?.state === "migrating") {
				ran = true;
				expect(store.reads.isHeld("app.provider:texts")).toBe(true);
				await during(gates);
			}
			return seq;
		};
		const close = async (): Promise<void> => {
			await host.close(context);
			await store.close(context);
		};
		return { store, host, gates, migrated: () => ran, close };
	}

	it("runs no statement compiled for the table as it was: no failed frame while another owner commits", async () => {
		// Round 1 (Sol 3, Opus S1; test list 11a): the other owner commits between the migration's commits, and that
		// commit runs no read at all.
		const meter = await metered();
		const { host, migrated, close } = await hosted_(async (gates) => {
			await gates.put(1, meter.context);
		});
		const view = await host.get(View, {}, context);
		const watch = await view.items.watch(context);
		const calls = changesOf(watch);
		await host.reload([provider(true), others], context);
		await flushed();
		await delivered();
		expect(migrated()).toBe(true);
		expect(meter.counts()["chord.query.runs"]).toBeUndefined();
		expect(calls.map((call) => (call.kind === "failed" ? String(call.error) : call.kind))).toEqual([]);
		expect(view.items.value.rows.map((row) => row.text)).toEqual(["first", "second"]);
		watch.stop();
		await close();
	});

	it("a list's more during the migration waits for the successor: no read of the old statement is registered", async () => {
		// Round 2 (Sol): `more` on the retired query registered a read of the old plan, which stayed in the index and
		// failed "no such column" on the next commit.
		let more: Promise<null> | undefined;
		const fixture = await hosted_(async (gates) => {
			await gates.put(1, context);
			// Not awaited here: it ends when the successor is live, which waits for this commit.
			more = screen.more(context);
		});
		const { host, store, gates, close } = fixture;
		const screen = await host.get(Screen, {}, context);
		expect(screen.items.value).toEqual({ rows: [{ id: 1, text: "first" }], moreAfter: true });
		await host.reload([provider(true), others], context);
		await more;
		await flushed();
		expect(screen.items.value.rows.map((row) => row.text)).toEqual(["first", "second"]);
		const reads = [...(store.reads.on("app.provider:texts") ?? [])];
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every((read) => read.plan.query.table === New)).toBe(true);
		// A later commit of the other owner runs the list's pages: none fails.
		await gates.put(2, context);
		await flushed();
		expect(screen.items.value.rows.map((row) => row.text)).toEqual(["first", "second"]);
		// Nothing of the handover keeps the old code's query.
		await expectCollected(declared[0]!);
		await close();
	});

	it("a write admitted before the provider's seal and paused across it publishes, then no old statement runs", async () => {
		// Test list 17: the old attempt's reads stay registered until its admitted work settled.
		const { host, store, gates, migrated, close } = await hosted_(async () => {});
		const rows = await host.get(Provider, {}, context);
		const view = await host.get(View, {}, context);
		await gates.put(3, context);
		const calls = changesOf(await view.items.watch(context));
		// The provider's next commit waits inside its step, after its admission and its reads' runs.
		const [entered, release] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const commit = store.commit.bind(store);
		store.commit = (writes, fence, ctx) => {
			store.commit = commit;
			const pause = {
				order: "write" as const,
				apply: async () => {
					entered.resolve();
					await release.promise;
					return [];
				},
			};
			return commit([...writes, pause], fence, ctx);
		};
		await rows.later({ id: 3, text: "third" }, context);
		await entered.promise;
		// No call is running: the reload seals the provider at once, with the write still in its step.
		const reloaded = host.reload([provider(true), others], context);
		await delivered();
		expect(migrated()).toBe(false);
		release.resolve();
		await reloaded;
		await flushed();
		await delivered();
		expect(migrated()).toBe(true);
		expect(calls.map((call) => (call.kind === "failed" ? String(call.error) : call.kind))).toEqual(["value"]);
		expect(view.items.value.rows.map((row) => row.text)).toEqual(["first", "second", "third"]);
		const reads = [...(store.reads.on("app.provider:texts") ?? [])];
		expect(reads.every((read) => read.plan.query.table === New)).toBe(true);
		await close();
	});

	it("a removed provider's reads leave the index: its readers keep their rows, another owner's commit runs nothing", async () => {
		// Round 2 (Opus S2): `Reads.retire` at the old attempt's end, with no successor and no hold to mask it.
		const { host, store, gates, close } = await hosted_(async () => {});
		const view = await host.get(View, {}, context);
		const before = view.items.value;
		await host.reload([others], context);
		await flushed();
		expect(store.reads.on("app.others:gate")).toBeUndefined();
		const meter = await metered();
		await gates.put(1, meter.context);
		await gates.put(3, meter.context);
		expect(meter.counts()["chord.query.runs"]).toBeUndefined();
		expect(view.items.value).toBe(before);
		await close();
	});

	it("keeps nothing of the old code's named query once its readers read the successor's", async () => {
		const { host, close } = await hosted_(async () => {});
		const view = await host.get(View, {}, context);
		const screen = await host.get(Screen, {}, context);
		await host.reload([provider(true), others], context);
		await flushed();
		expect(view.items.value.rows).toHaveLength(2);
		expect(screen.items.value.rows).toHaveLength(1);
		expect(declared).toHaveLength(1);
		await expectCollected(declared[0]!);
		await close();
	});
});

describe("staging (code review round 1)", () => {
	it("keeps a plugin on its old code when its new factory declares a read wrongly", async () => {
		// Opus S7, Fable S10: the checks an attempt makes that need no handle run against the recording `self`.
		const store = await memoryStore();
		const { host } = await hosted(store);
		const page = await host.get(TeamPage, { team: "u12" }, context);
		const wrong = (declare: (self: StoreSelf) => unknown): Plugin => ({
			name: "@test/club",
			facet: defineFacet((h) => serveClub(h, undefined, undefined, declare)),
		});
		const teams = (self: StoreSelf) => self.get(Club, {}).teams.ofTeam;
		// Plugin code is bundled without type checks.
		const failed = async (declare: (self: StoreSelf) => unknown): Promise<string> => {
			const report = await host.reload([publisher(), wrong(declare)], context);
			return report.failed.map((failure) => String(failure.error)).join();
		};
		expect(await failed((self) => self.liveQuery(teams(self), { team: "u12" }, {} as never))).toContain(
			"self.liveQuery: { first: n } is required",
		);
		expect(await failed((self) => self.list("", [[teams(self), { team: "u12" }]], { first: 2 }).value)).toContain(
			"a list has a name",
		);
		expect(
			await failed((self) => {
				self.list("a", [[teams(self), { team: "u12" }]], { first: 2 });
				return self.list("a", [[teams(self), { team: "u12" }]], { first: 2 }).value;
			}),
		).toContain('list "a" is declared twice');
		// The old code still serves the page.
		expect(page.sessions.value.rows.map((row) => row.session)).toEqual(["s1", "s0"]);
		await host.close(context);
		await store.close(context);
	});
	it("refuses a table given to a reader and a named query given to self.query, as an attempt does", async () => {
		// Round 2 (Sol S1): a recorded handle says whether it stands for a table or a named query.
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const Counted = local("app.counted", { version: 1, params: {}, members: { n: int() } });
		const Plain = defineTable("plain", { version: 1, columns: { id: int() }, key: ["id"] });
		const serving = (declare: (self: StoreSelf) => unknown): Plugin => ({
			name: "@test/counted",
			facet: defineFacet((h) =>
				h.serve(Counted, ((_: unknown, self: StoreSelf) => ({ n: declare(self) })) as never),
			),
		});
		await host.load([serving((self) => self.derive([], () => 1))], context);
		const counted = await host.get(Counted, {}, context);
		// Plugin code is bundled without type checks.
		const failed = async (declare: (self: StoreSelf) => unknown): Promise<string> => {
			const report = await host.reload([serving(declare)], context);
			return report.failed.map((failure) => String(failure.error)).join();
		};
		const named = (self: StoreSelf) =>
			self.queries(self.table(Plain), { map: (row) => row }, { all: [obj({}), () => query(Plain)] });
		expect(await failed((self) => self.count(self.table(Plain) as never, {}))).toContain(
			"self.count reads a named query; a table of this object is read with self.query",
		);
		expect(await failed((self) => self.liveQuery(self.table(Plain) as never, {}, { first: 1 }))).toContain(
			"self.liveQuery reads a named query",
		);
		expect(await failed((self) => self.list("l", [["no query" as never, {}]], { first: 1 }).value)).toContain(
			'self.list "l" reads a named query',
		);
		expect(await failed((self) => self.query(named(self).all as never, query(Plain), 5))).toContain(
			"self.query reads a table of this object; a named query is read with self.liveQuery",
		);
		expect(await failed((self) => self.queries({} as never, { map: (row) => row }, {}))).toContain(
			"self.queries: the table is not one this factory declared",
		);
		// What an attempt accepts, staging accepts: the object's own named query, read and counted.
		expect(await failed((self) => self.count(named(self).all, {}))).toBe("");
		await flushed();
		expect(counted.n.value).toBe(0);
		await host.close(context);
		await store.close(context);
	});
});

describe("a reference's named queries, made on first use (slice 15 §5)", () => {
	/** A store contract of `count` named queries over the team rows, `q0` to `q<count - 1>`. */
	function manyQueries(count: number) {
		const args = Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index}`, obj({ team: str() })]));
		return local("app.many", { version: 1, params: {}, members: { rows: queries(TeamItem, args) } });
	}

	it("a reference to 23 named queries, none read, keeps none; one read is made once and works as before", async () => {
		const Many = manyQueries(23);
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const plugin = defineFacet((h) => {
			serveSessions(h);
			h.serve(Many, (_, self) => {
				const builders = Object.fromEntries(
					Array.from({ length: 23 }, (_, index) => [
						`q${index}`,
						({ team }: { team: string }) => query(TeamRows).where((t) => eq(t.team, team)),
					]),
				);
				return {
					rows: self.queries(
						self.table(TeamRows),
						{ map: (row) => ({ session: row.session.params.id, title: row.team, touched: 0 }) },
						builders,
					),
				};
			});
		});
		await host.load([{ name: "@test/many", facet: plugin }], context);
		const many = await host.get(Many, {}, context);
		// No `ReferenceQuery` exists: the member's object has no own property, its names are its class's getters.
		expect(Object.getOwnPropertyNames(many.rows)).toEqual([]);
		expect("q7" in many.rows).toBe(true);
		const q7 = many.rows.q7;
		expect(Object.getOwnPropertyNames(many.rows)).toEqual(["q7"]);
		expect(many.rows.q7).toBe(q7);
		// Read as before; its label (errors and reports) is built when asked.
		expect(await q7.page({ team: "u12" }, 5, context)).toEqual({ items: [] });
		expect((q7 as unknown as ReferenceQuery).label).toMatch(/^app\.many.*: query "rows\.q7"$/);
		await host.close(context);
		await store.close(context);
	});

	it("keeps no contract: the classes of the members' objects are held weakly by the contract's version", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([], context);
		// A reference made and released: the class cached for the member's `QueriesData` goes with its contract (the
		// cache's key, not the contract's handle, is what a strong cache would keep; review round 1, Astra 8).
		const key = await (async () => {
			const Many = manyQueries(3);
			host.hold(Many, {}, context).release();
			return new WeakRef(currentVersion(Many).members.queries.get("rows")!);
		})();
		await host.close(context);
		await expectCollected(key);
	});
});
