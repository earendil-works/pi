// The store's reads (slice 14 §3.2, §5): the index from a table to the reads over it, the bindings of column sets
// (one table per name, moved or dropped by their owner alone), tables held while they are not ready, and the refresh
// a commit stages: it takes its reads from the index inside the step and runs none over a held table.

import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind, int, str } from "../../src/contracts/index.ts";
import { Batch } from "../../src/state/internal.ts";
import { defineColumns } from "../../src/store/column-set.ts";
import { eq, exists } from "../../src/store/expression.ts";
import { host } from "../../src/store/host-column.ts";
import { OpenQuery } from "../../src/store/open-query.ts";
import { query } from "../../src/store/query.ts";
import type { ReadRun } from "../../src/store/read.ts";
import { ReadRefresh, Reads } from "../../src/store/reads.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { TableChanges } from "../../src/store/table-changes.ts";
import type { TableHandle } from "../../src/store/table-handle.ts";
import { expectCollected, memoryStore, tableIn } from "../support.ts";
import {
	closeWorld,
	commit as commitWorld,
	opened as openedWorld,
	openRead,
	random,
	randomWrite,
	staleReads,
	SessionColumns as WorldSessionColumns,
	Sessions as WorldSessions,
} from "./read-world.ts";

const Session = hostKind("session", { id: str() });
const TagSet = defineColumns("tags.columns", { columns: { note: int(), tag: str() }, key: ["note", "tag"] });
const Tags = defineTable("tags", { version: 1, columns: { ...TagSet.columns }, key: ["note", "tag"], exposes: TagSet });
const Notes = defineTable("notes", { version: 1, columns: { id: int(), text: str() }, key: ["id"] });
const Owned = defineTable("owned", { version: 1, columns: { id: int(), session: host(Session) }, key: ["id"] });

const TAGGED = query(Notes).where((n) => exists(TagSet, { note: n.id }, (t) => eq(t.tag, "red")));

let store: ChordStore;
afterEach(async () => {
	await store?.close(context);
});

describe("bindings", () => {
	it("bind one table per set name: another owner's other table is refused, naming both; only the owner unbinds", () => {
		const reads = new Reads();
		const [owner, other] = [{}, {}];
		reads.bind("tags.columns", { table: "a:tags", definition: Tags }, owner);
		expect(reads.get("tags.columns")?.table).toBe("a:tags");
		expect(() => reads.bind("tags.columns", { table: "b:tags", definition: Tags }, other)).toThrow(
			'column set "tags.columns" is exposed by tables "a:tags" and "b:tags"',
		);
		reads.unbind("tags.columns", other);
		expect(reads.boundBy(owner)).toEqual(["tags.columns"]);
		// The owner moves the set to another of its tables, then drops it.
		reads.bind("tags.columns", { table: "a:tags2", definition: Tags }, owner);
		expect(reads.get("tags.columns")?.table).toBe("a:tags2");
		reads.unbind("tags.columns", owner);
		expect(reads.get("tags.columns")).toBeUndefined();
	});

	it("tell a set's watchers of a binding, a move, a drop and its table's readiness, until they release", () => {
		const reads = new Reads();
		const owner = {};
		let told = 0;
		const release = reads.watch("tags.columns", () => told++);
		reads.bind("tags.columns", { table: "a:tags", definition: Tags }, owner);
		// The same binding again changes nothing.
		reads.bind("tags.columns", { table: "a:tags", definition: Tags }, owner);
		reads.hold("a:tags");
		expect(reads.isHeld("a:tags")).toBe(true);
		reads.ready("a:tags");
		reads.ready("a:tags");
		reads.unbind("tags.columns", owner);
		expect(told).toBe(3);
		release();
		reads.bind("tags.columns", { table: "a:tags", definition: Tags }, owner);
		expect(told).toBe(3);
	});
});

/** An open query of `q` over `handle`'s table with one read of it, and every run its sink adopted. */
async function opened(handle: TableHandle, q = TAGGED) {
	const runs: ReadRun[] = [];
	const batch = new Batch(() => {}, undefined);
	const spec = { query: q, table: handle.sql.table, projection: {}, owner: handle };
	// A binding changed: its one read runs again, as a live query's.
	const opened = new OpenQuery({ store, batch }, spec, "rows", () => void open.load(), context);
	const open = opened.read({ kind: "rows", range: { limit: 5 } }, { adopt: (run) => void runs.push(run) });
	await open.load();
	return { open, query: opened, runs, batch };
}

/** Commits one put into `handle`'s table with the refresh a transaction stages. */
async function put(handle: TableHandle, row: object, batch: Batch): Promise<void> {
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(handle, staged);
	changes.put(row);
	const refresh = new ReadRefresh(store.reads, [handle.sql.table], () => changes.changes(), context);
	staged.push(refresh.write);
	await store.commit(
		staged,
		{ admit: () => true, adopt: () => batch.commit(() => refresh.adopt(), context) },
		context,
	);
}

const shown = (run: ReadRun | undefined): unknown =>
	run === undefined ? "none" : run.kind === "rows" ? run.result.rows.map((row) => row.id) : run.kind;

/**
 * Starts a commit of one put into `handle`'s table whose step waits, after its reads ran, until `release`: what
 * happens meanwhile happens between a read's run and its adoption.
 */
async function pausedPut(handle: TableHandle, row: object, batch: Batch) {
	const [ran, release] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(handle, staged);
	changes.put(row);
	const refresh = new ReadRefresh(store.reads, [handle.sql.table], () => changes.changes(), context);
	const pause: StagedWrite = {
		order: "write",
		apply: async () => {
			ran.resolve();
			await release.promise;
			return [];
		},
	};
	staged.push(refresh.write, pause);
	const fence = { admit: () => true, adopt: () => batch.commit(() => refresh.adopt(), context) };
	const committed = store.commit(staged, fence, context);
	await ran.promise;
	return { release: release.resolve, committed };
}

describe("a run belongs to the registration that computed it (code review round 2)", () => {
	it("a commit's run of a plan the query no longer has is dropped: it cannot heal the failure that followed it", async () => {
		// Astra: another owner's commit ran the read; the set was withdrawn (a failed run, `unavailable`); the commit
		// then adopted the run its step had made with the old plan, and the read showed rows of a set nobody serves.
		store = await memoryStore();
		const [notes, tags] = [await tableIn(store, Notes), await tableIn(store, Tags)];
		store.reads.bind(TagSet.name, { table: tags.sql.table, definition: Tags }, tags);
		const { query: opened_, runs, batch } = await opened(notes);
		await put(tags, { note: 1, tag: "red" }, batch);
		// The step runs the read: the new note passes its condition.
		const before = runs.length;
		const paused = await pausedPut(notes, { id: 1, text: "t" }, batch);
		store.reads.unbind(TagSet.name, tags);
		expect(runs.slice(before)).toMatchObject([{ kind: "failed" }]);
		const failed = runs.length;
		paused.release();
		await paused.committed;
		expect(runs).toHaveLength(failed);
		// Bound again, the new registration reads for itself.
		store.reads.bind(TagSet.name, { table: tags.sql.table, definition: Tags }, tags);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(shown(runs.at(-1))).toEqual([1]);
		opened_.close();
	});

	it("a run a commit made before the read closed still reaches its sink: a list's retired page", async () => {
		store = await memoryStore();
		const notes = await tableIn(store, Notes);
		const { open, query: opened_, runs, batch } = await opened(notes, query(Notes) as never);
		const paused = await pausedPut(notes, { id: 1, text: "t" }, batch);
		open.close();
		paused.release();
		await paused.committed;
		expect(shown(runs.at(-1))).toEqual([1]);
		opened_.close();
	});
});

describe("an open query's reads (hot-path pass)", () => {
	it("are re-registered on a binding change and closed with it, one or several, also after the only one closed", async () => {
		// The one read is kept without a set (152 B), the second makes one: every open read is told either way.
		store = await memoryStore();
		const [notes, tags] = [await tableIn(store, Notes), await tableIn(store, Tags)];
		store.reads.bind(TagSet.name, { table: tags.sql.table, definition: Tags }, tags);
		const { open: first, query: opened_ } = await opened(notes);
		first.close();
		const range = { kind: "rows", range: { limit: 5 } } as const;
		const sink = { adopt: () => {} };
		const reads = [opened_.read(range, sink)];
		const registered = () => reads.map((read) => read.read);
		// The set's table ready again after a migration: the query compiles again and its reads are registered anew.
		const recompiled = () => {
			store.reads.hold(tags.sql.table);
			store.reads.ready(tags.sql.table);
		};
		const before = registered();
		recompiled();
		const after = registered();
		expect(after.every((read, at) => read !== undefined && read !== before[at])).toBe(true);
		reads.push(opened_.read(range, sink), opened_.read(range, sink));
		reads[1]!.close();
		const several = registered();
		recompiled();
		expect(registered().map((read, at) => (read === undefined ? "closed" : read !== several[at]))).toEqual([
			true,
			"closed",
			true,
		]);
		opened_.close();
		expect(registered()).toEqual([undefined, undefined, undefined]);
		expect(store.reads.on(notes.sql.table)).toBeUndefined();
	});
});

describe("the index and the refresh", () => {
	it("enter a read under every table it uses: the other owner's commit runs it; closed, nothing does", async () => {
		store = await memoryStore();
		const [notes, tags] = [await tableIn(store, Notes), await tableIn(store, Tags)];
		store.reads.bind(TagSet.name, { table: tags.sql.table, definition: Tags }, tags);
		const { query: opened_, runs, batch } = await opened(notes);
		expect([store.reads.on(notes.sql.table)?.size, store.reads.on(tags.sql.table)?.size]).toEqual([1, 1]);
		await put(notes, { id: 1, text: "t" }, batch);
		await put(tags, { note: 1, tag: "red" }, batch);
		expect(shown(runs.at(-1))).toEqual([1]);
		const before = runs.length;
		opened_.close();
		expect(store.reads.on(tags.sql.table)).toBeUndefined();
		await put(tags, { note: 1, tag: "blue" }, batch);
		expect(runs).toHaveLength(before);
	});

	it("a query that does not compile is a failed run; the set bound later, it compiles and runs once", async () => {
		store = await memoryStore();
		const [notes, tags] = [await tableIn(store, Notes), await tableIn(store, Tags)];
		const { open, query: opened_, runs } = await opened(notes);
		expect(runs.map((run) => (run.kind === "failed" ? String(run.error) : run.kind))).toEqual([
			'ChordError: column set "tags.columns" is not served',
		]);
		expect(open.read).toBeUndefined();
		store.reads.bind(TagSet.name, { table: tags.sql.table, definition: Tags }, tags);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(shown(runs.at(-1))).toEqual([]);
		opened_.close();
	});

	it("run no read over a held table, and one run when it is ready", async () => {
		store = await memoryStore();
		const [notes, tags] = [await tableIn(store, Notes), await tableIn(store, Tags)];
		store.reads.bind(TagSet.name, { table: tags.sql.table, definition: Tags }, tags);
		const { query: opened_, runs, batch } = await opened(notes);
		await put(notes, { id: 1, text: "t" }, batch);
		const before = runs.length;
		store.reads.hold(tags.sql.table);
		// Another owner commits between two chunks of the migration: the read keeps its rows.
		await put(notes, { id: 2, text: "t" }, batch);
		await put(tags, { note: 2, tag: "red" }, batch);
		expect(runs).toHaveLength(before);
		store.reads.ready(tags.sql.table);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(runs).toHaveLength(before + 1);
		expect(shown(runs.at(-1))).toEqual([2]);
		opened_.close();
	});

	it("find the reads over tables with a host column of a kind, joined and exists tables included", async () => {
		store = await memoryStore();
		const [notes, owned] = [await tableIn(store, Notes), await tableIn(store, Owned)];
		const OwnedSet = defineColumns("owned.columns", { columns: { id: int(), session: host(Session) }, key: ["id"] });
		const Exposing = defineTable("owned", {
			version: 1,
			columns: { ...OwnedSet.columns },
			key: ["id"],
			exposes: OwnedSet,
		});
		store.reads.bind(OwnedSet.name, { table: owned.sql.table, definition: Exposing }, owned);
		const direct = await opened(owned, query(Owned) as never);
		const through = await opened(notes, query(Notes).where((n) => exists(OwnedSet, { id: n.id })) as never);
		const plain = await opened(notes, query(Notes) as never);
		expect(store.reads.onHostKind("session")).toHaveLength(2);
		expect(store.reads.onHostKind("server")).toEqual([]);
		for (const each of [direct, through, plain]) each.query.close();
	});

	it("close the queries of an owner that retires: their reads leave the index, others stay", async () => {
		// Code review round 1 (Opus S1, Sol 3): a provider's attempt ended; no commit runs its queries again.
		store = await memoryStore();
		const notes = await tableIn(store, Notes);
		const retiring = await opened(notes, query(Notes) as never);
		const other = {};
		const batch = new Batch(() => {}, undefined);
		const spec = { query: query(Notes) as never, table: notes.sql.table, projection: {}, owner: other };
		const staying = new OpenQuery({ store, batch }, spec, "rows", () => {}, context);
		staying.read({ kind: "rows", range: { limit: 5 } }, { adopt: () => {} });
		store.reads.retire(notes);
		expect([retiring.query.closed, staying.closed, store.reads.on(notes.sql.table)?.size]).toEqual([true, false, 1]);
		const before = retiring.runs.length;
		await put(notes, { id: 1, text: "t" }, retiring.batch);
		expect(retiring.runs).toHaveLength(before);
		staying.close();
	});

	it("a read of a closed query is closed: never registered, never run", async () => {
		// Code review round 2 (Sol): a list whose provider retired asked its closed query for another page; the read
		// of the old plan stayed in the index for good.
		store = await memoryStore();
		const notes = await tableIn(store, Notes);
		const { query: opened_, batch } = await opened(notes, query(Notes) as never);
		store.reads.retire(notes);
		const runs: ReadRun[] = [];
		const late = opened_.read({ kind: "rows", range: { limit: 5 } }, { adopt: (run) => void runs.push(run) });
		const known = opened_.readKnown({ limit: 5 }, [], { adopt: (run) => void runs.push(run) });
		expect([late.read, known.read, store.reads.on(notes.sql.table)]).toEqual([undefined, undefined, undefined]);
		expect(await late.load()).toBeUndefined();
		await put(notes, { id: 1, text: "t" }, batch);
		expect(runs).toEqual([]);
	});

	it("keep nothing of a closed read", async () => {
		store = await memoryStore();
		const notes = await tableIn(store, Notes);
		const { open, query: opened_ } = await opened(notes, query(Notes) as never);
		const read = new WeakRef(open.read!);
		opened_.close();
		await expectCollected(read);
	});

	it("keep nothing of a closed query that watched a set's binding", async () => {
		store = await memoryStore();
		const [notes, tags] = [await tableIn(store, Notes), await tableIn(store, Tags)];
		store.reads.bind(TagSet.name, { table: tags.sql.table, definition: Tags }, tags);
		// Opened and closed in a function of its own: nothing of this test keeps the query.
		const closed = async (): Promise<WeakRef<object>> => {
			const { query: opened_ } = await opened(notes);
			opened_.close();
			return new WeakRef(opened_);
		};
		await expectCollected(await closed());
		// The binding changes without a watcher left to tell.
		store.reads.unbind(TagSet.name, tags);
	});
});

describe("calls into a condition's lists, by phase (hot-path review guard)", () => {
	// The second reviewer's count (opus-calls): a read whose condition is built of lists that count their method
	// calls and iterations, opened, run through 150 random commits, checked and closed. The counts are the store's as
	// of this pass: a change that calls a list's method more often, or in another phase, fails here and must say why.
	const METHODS = [
		"map",
		"slice",
		"join",
		"every",
		"some",
		"filter",
		"forEach",
		"indexOf",
		"includes",
		"entries",
		"flatMap",
		"concat",
		"find",
		"findIndex",
		"reduce",
		"keys",
		"values",
		"at",
		"sort",
		"toSorted",
		"flat",
		"lastIndexOf",
	] as const;

	it("opens, refreshes and closes a read with the calls of this pass", async () => {
		const calls = new Map<string, number>();
		let phase = "setup";
		const counted = <T>(name: string, items: T[]): T[] => {
			const count = (what: string): void => {
				const key = `${phase} ${name}.${what}`;
				calls.set(key, (calls.get(key) ?? 0) + 1);
			};
			class Counted extends Array<T> {}
			for (const method of METHODS) {
				const original = (Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!;
				Object.defineProperty(Counted.prototype, method, {
					value(this: unknown, ...args: unknown[]) {
						count(method);
						return original.apply(this, args);
					},
				});
			}
			Object.defineProperty(Counted.prototype, Symbol.iterator, {
				value(this: unknown) {
					count("iterator");
					return Array.prototype[Symbol.iterator].call(this as unknown[]);
				},
			});
			return Counted.from(items) as T[];
		};
		const w = await openedWorld(context, []);
		try {
			const node = {
				and: [
					{ inArray: ["app", counted("apps", ["club", "family"])] },
					{ inArray: ["state", counted("states", ["working", "idle"])] },
					{ exists: ["club.team-sessions", counted("pairs", [counted("pair", ["session", "id"])]), null] },
				],
			};
			phase = "open";
			const q = query(WorldSessions).whereNode(WorldSessionColumns, node);
			const what = { kind: "rows", range: { limit: 5 } } as const;
			const read = await openRead(w, { name: "counted", query: q, table: WorldSessions, what }, context);
			phase = "commits";
			const next = random(7);
			for (let clock = 1; clock <= 150; clock++) {
				await commitWorld(w, context, (changes) => randomWrite(next, changes, clock));
			}
			phase = "check";
			expect(await staleReads(w, context)).toEqual([]);
			phase = "close";
			read.query.close();
		} finally {
			phase = "teardown";
			await closeWorld();
		}
		expect(Object.fromEntries([...calls].sort(([a], [b]) => (a < b ? -1 : 1)))).toEqual({
			"commits pairs.every": 40,
			"commits pairs.iterator": 23,
			"commits pairs.join": 1,
			"commits pairs.map": 24,
			"commits pairs.slice": 1,
			"open apps.iterator": 1,
			"open apps.map": 3,
			"open pair.iterator": 5,
			"open pairs.every": 2,
			"open pairs.includes": 3,
			"open pairs.iterator": 4,
			"open pairs.join": 1,
			"open pairs.map": 5,
			"open states.iterator": 1,
			"open states.map": 4,
		});
	}, 60_000);
});
