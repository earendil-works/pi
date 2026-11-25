// The skip test's oracle (slice 14 §3.3, test 13a): in randomized runs of writes over own, joined and `exists`
// tables, with reads of every shape the slice's screens use, every read's adopted result equals a fresh run of its
// statement after every commit, whether the commit ran it again or skipped it. And the deterministic cases of the
// rule's table: what skips without a probe, what a probe decides, what always runs.

import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { eq } from "../../src/store/expression.ts";
import { ReadRefresh } from "../../src/store/reads.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import type { TableDefinition } from "../../src/store/table.ts";
import { TableChanges } from "../../src/store/table-changes.ts";
import { metered } from "../support.ts";
import {
	closeWorld,
	commit,
	expectFresh,
	opened,
	Pins,
	random,
	randomWrite,
	Sessions,
	Shares,
	shown,
	Teams,
} from "./read-world.ts";

afterEach(closeWorld);

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
		// Ben's session touched: neither in the read before nor in its bucket (anna's) after, so the commit index
		// (slice 15 §3) leaves the read out: not even skip-tested.
		expect(await cost((changes) => changes(Sessions).update({ id: "s06" }, { lastTouch: 999 }))).toEqual({
			runs: 0,
			probes: 0,
			skips: 0,
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
		// A delete of a row that was not fetched concerns no read (the commit index); of the row past the bound it runs.
		expect(await cost((changes) => changes(Sessions).delete({ id: "s07" }))).toEqual({
			runs: 0,
			probes: 0,
			skips: 0,
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
			for (const id of ["s01", "s02", "s03", "s04"]) changes(Sessions).put(session(id));
		});
		// Anna's rows behind the window's last one: each a candidate, each probe a miss.
		const bulk = await cost((changes) => {
			for (let index = 0; index < 100; index++) changes(Sessions).put(session(`b${index}`, { lastTouch: 1 }));
		});
		expect(bulk).toEqual({ runs: 1, probes: 8, skips: 0 });
		// Rows of another person's bucket are no candidates (slice 15 §3): the limit counts the read's candidate rows.
		const others = await cost((changes) => {
			for (let index = 0; index < 100; index++) changes(Sessions).put(session(`c${index}`, { creator: "ben" }));
		});
		expect(others).toEqual({ runs: 0, probes: 0, skips: 0 });
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
