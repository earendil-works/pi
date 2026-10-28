// Tests of tables brought to their version at activation (slice 6a §9): fresh tables created at the newest version,
// eager migrations one version at a time in their commits ((A), chunks of 100, (Z)), `rows` and `update` steps,
// index edits, resumption at `migrating`, and the refusals that leave the data as it was.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, nul, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { lt } from "../../../src/next/store/expression.ts";
import { json } from "../../../src/next/store/json-column.ts";
import { query } from "../../../src/next/store/query.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable, type TableDefinition } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { TableHandle } from "../../../src/next/store/table-handle.ts";
import { MIGRATION_CHUNK, prepareTables } from "../../../src/next/store/table-migration.ts";
import { memoryStore, rejection, tableOwner } from "../support.ts";

const TABLE = "app.store:edits";
const OPEN = { admit: () => true, adopt: () => {} };

const EditsV1 = defineTable("edits", {
	version: 1,
	columns: { id: str(), file: str(), at: int() },
	key: ["id"],
	indexes: { by_file: ["file"] },
});
const EditsV2 = evolveTable(EditsV1, (t) =>
	t
		.rename("file", "path")
		.add("dir", str({ default: "" }))
		.rows((row) => ({ dir: row.path.slice(0, row.path.lastIndexOf("/")) })),
);
const EditsV3 = evolveTable(EditsV2, (t) => t.drop("dir").index("by_path", ["path", "at"]));

let store: ChordStore;
afterEach(async () => {
	await store?.close(context);
});

/** Prepares `definition` as the edits table of `store`; a handle to it. */
async function prepared(definition: TableDefinition): Promise<TableHandle> {
	await prepareTables([{ definition, table: TABLE }], store, OPEN, "app.store", context);
	return new TableHandle(definition, TABLE, store, tableOwner());
}

/** A store whose edits table is at version 1 with `count` rows e000.. (file `d<i % 3>/f<i>`, at `i`). */
async function filled(count: number): Promise<void> {
	store = await memoryStore({ outbox: true });
	const edits = await prepared(EditsV1);
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(edits, staged);
	for (let i = 0; i < count; i++) changes.put({ id: id(i), file: `d${i % 3}/f${i}`, at: i });
	await store.commit(staged, OPEN, context);
}

function id(i: number): string {
	return `e${String(i).padStart(3, "0")}`;
}

/** The kinds of the writes of every commit after `seq`, each kind with its count. */
async function commitsAfter(seq: number): Promise<string[][]> {
	const commits = await store.outbox!.read(seq, 100, context);
	return commits.map(({ writes }) => {
		const counts = new Map<string, number>();
		for (const { kind } of writes) counts.set(kind, (counts.get(kind) ?? 0) + 1);
		return [...counts].map(([kind, count]) => (count === 1 ? kind : `${kind} x${count}`));
	});
}

/** Every row of `handle`, in key order. */
async function all(handle: TableHandle, definition: TableDefinition): Promise<unknown[]> {
	const rows: unknown[] = [];
	for await (const row of handle.rows(query(definition), context)) rows.push(row);
	return rows;
}

describe("fresh tables", () => {
	it("are created at the newest version, ready, with their indexes, in one commit (no replay)", async () => {
		store = await memoryStore({ outbox: true });
		await prepared(EditsV3);
		expect(store.table(TABLE)).toMatchObject({
			version: 3,
			state: "ready",
			fingerprint: EditsV3.fingerprint,
			indexes: { by_file: ["path"], by_path: ["path", "at"] },
		});
		expect(await commitsAfter(0)).toEqual([["table", "index x2"]]);
	});

	it("a table at the newest version, ready, is used as recorded: nothing is written", async () => {
		await filled(1);
		const seq = store.lastSeq;
		await prepared(EditsV1);
		expect(store.lastSeq).toBe(seq);
	});
});

describe("eager migrations", () => {
	it("one version at a time: (A), chunks of 100 in key order, (Z) with the later edits and ready", async () => {
		await filled(250);
		const seq = store.lastSeq;
		const edits = await prepared(EditsV3);
		expect(await commitsAfter(seq)).toEqual([
			["alter x2", "table"],
			["update x100"],
			["update x100"],
			["update x50", "table"],
			["alter", "index", "table"],
		]);
		expect(store.table(TABLE)).toMatchObject({
			version: 3,
			state: "ready",
			columns: { id: { type: "str" }, path: { type: "str" }, at: { type: "int" } },
			indexes: { by_file: ["path"], by_path: ["path", "at"] },
		});
		const rows = await all(edits, EditsV3);
		expect(rows).toHaveLength(250);
		expect(rows[4]).toEqual({ id: "e004", path: "d1/f4", at: 4 });
	});

	it("the data step reads the columns as they stand at its version and fills the one it adds", async () => {
		await filled(3);
		const edits = await prepared(EditsV2);
		expect(await all(edits, EditsV2)).toEqual([
			{ id: "e000", path: "d0/f0", at: 0, dir: "d0" },
			{ id: "e001", path: "d1/f1", at: 1, dir: "d1" },
			{ id: "e002", path: "d2/f2", at: 2, dir: "d2" },
		]);
	});

	it("the migration's rows carry the internal form: the patch and the version stamped as $v", async () => {
		await filled(1);
		const seq = store.lastSeq;
		await prepared(EditsV2);
		const [, chunk] = await store.outbox!.read(seq, 10, context);
		expect(chunk!.writes).toEqual([
			{ kind: "update", table: TABLE, key: { id: "e000" }, set: { dir: "d0" }, columns: {}, count: 1, version: 2 },
			expect.objectContaining({ kind: "table", version: 2, state: "ready" }),
		]);
	});

	it("an empty table still runs (A) and (Z); a version without a data step is one commit", async () => {
		await filled(0);
		const seq = store.lastSeq;
		await prepared(EditsV3);
		expect(await commitsAfter(seq)).toEqual([["alter x2", "table"], ["table"], ["alter", "index", "table"]]);
	});

	it("a dropped column's indexes are dropped first, in the same commit", async () => {
		await filled(2);
		const Dropped = evolveTable(EditsV1, (t) => t.drop("file"));
		const seq = store.lastSeq;
		const edits = await prepared(Dropped);
		const [commit] = await store.outbox!.read(seq, 10, context);
		expect(commit!.writes.slice(0, 2)).toEqual([
			{ kind: "dropIndex", table: TABLE, name: "by_file" },
			{ kind: "alter", table: TABLE, version: 2, edit: { kind: "drop", name: "file" } },
		]);
		expect(store.table(TABLE)).toMatchObject({ columns: { id: { type: "str" }, at: { type: "int" } }, indexes: {} });
		expect(await all(edits, Dropped)).toEqual([
			{ id: "e000", at: 0 },
			{ id: "e001", at: 1 },
		]);
	});

	it("an update step is one updateWhere over the rows below its version, stamping it, with ready", async () => {
		await filled(5);
		const Bumped = evolveTable(EditsV1, (t) => t.update({ where: (e) => lt(e.at, 3), set: { file: "old" } }));
		const seq = store.lastSeq;
		const edits = await prepared(Bumped);
		const commits = await store.outbox!.read(seq, 10, context);
		expect(commits.map(({ writes }) => writes.map(({ kind }) => kind))).toEqual([
			["table"],
			["updateWhere", "table"],
		]);
		expect(commits[1]!.writes[0]).toMatchObject({ kind: "updateWhere", count: 3, version: 2, set: { file: "old" } });
		expect((await all(edits, Bumped)).map((row) => (row as { file: string }).file)).toEqual([
			"old",
			"old",
			"old",
			"d0/f3",
			"d1/f4",
		]);
	});

	it("a json(...) version change records the column's version: no DDL, cells migrate on access", async () => {
		const Notes1 = defineTable("edits", {
			version: 1,
			columns: { id: str(), meta: opt(json(obj({ a: int() }), { version: 1 })) },
			key: ["id"],
		});
		const Notes2 = evolveTable(Notes1, (t) =>
			t.json(
				"meta",
				json(obj({ a: int(), b: int() }), { version: 2, migrate: (old) => ({ ...(old as { a: number }), b: 0 }) }),
			),
		);
		store = await memoryStore({ outbox: true });
		const v1 = await prepared(Notes1);
		const staged: StagedWrite[] = [];
		new TableChanges(v1, staged).put({ id: "a", meta: { a: 1 } });
		await store.commit(staged, OPEN, context);
		const seq = store.lastSeq;
		const v2 = await prepared(Notes2);
		const [commit] = await store.outbox!.read(seq, 10, context);
		expect(commit!.writes).toEqual([
			{
				kind: "alter",
				table: TABLE,
				version: 2,
				edit: { kind: "json", name: "meta", column: expect.objectContaining({ type: "json", version: 2 }) },
			},
			expect.objectContaining({ kind: "table", version: 2, state: "ready" }),
		]);
		expect(await v2.get({ id: "a" }, context)).toEqual({ id: "a", meta: { a: 1, b: 0 } });
	});
});

describe("the chunk yield", () => {
	it("yields between chunks without Node's setImmediate (Workers, browsers), through a message, not a timer", async () => {
		await filled(3 * MIGRATION_CHUNK);
		const saved = globalThis.setImmediate;
		// Runtimes without it: Cloudflare Workers, browsers.
		Reflect.deleteProperty(globalThis, "setImmediate");
		const timers = vi.spyOn(globalThis, "setTimeout");
		try {
			await prepared(EditsV2);
			expect(timers).not.toHaveBeenCalled();
		} finally {
			timers.mockRestore();
			globalThis.setImmediate = saved;
		}
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "ready" });
	});

	it("yields between chunks without a timer (no 1 ms clamp), while timers due run in between (a latency guard)", async () => {
		await filled(10 * MIGRATION_CHUNK);
		let fired = false;
		// Due during the migration: it fires between chunks (a microtask-only loop would starve it).
		setTimeout(() => {
			fired = true;
		}, 0);
		const timers = vi.spyOn(globalThis, "setTimeout");
		try {
			await prepared(EditsV2);
			expect(timers).not.toHaveBeenCalled();
		} finally {
			timers.mockRestore();
		}
		expect(fired).toBe(true);
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "ready" });
	});
});

describe("patches", () => {
	it("a rows patch writes a JSON null into a json(...) cell and clears an opt column with undefined", async () => {
		const Cells1 = defineTable("edits", {
			version: 1,
			columns: { id: str(), data: json(nul(), { version: 1 }), note: opt(str()) },
			key: ["id"],
		});
		const Cells2 = evolveTable(Cells1, (t) =>
			t.add("more", opt(json(nul(), { version: 1 }))).rows(() => ({ more: null, note: undefined })),
		);
		store = await memoryStore();
		const v1 = await prepared(Cells1);
		const staged: StagedWrite[] = [];
		new TableChanges(v1, staged).put({ id: "a", data: null, note: "n" });
		await store.commit(staged, OPEN, context);
		const v2 = await prepared(Cells2);
		expect(await v2.get({ id: "a" }, context)).toEqual({ id: "a", data: null, more: null });
	});
});

describe("resumption", () => {
	it("a data step that throws leaves the table migrating with its committed chunks; the next run continues", async () => {
		await filled(250);
		let fail = true;
		const Failing = evolveTable(EditsV1, (t) =>
			t.rows((row) => {
				if (fail && row.id === id(150)) throw new Error("crash");
				return { file: `${row.file}!` };
			}),
		);
		expect(await rejection(prepared(Failing))).toMatchObject({ message: "crash" });
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "migrating" });
		const seq = store.lastSeq;
		fail = false;
		const edits = await prepared(Failing);
		expect(await commitsAfter(seq)).toEqual([["update x100"], ["update x50", "table"]]);
		const files = (await all(edits, Failing)).map((row) => (row as { file: string }).file);
		// Every row patched once: the first chunk's rows were skipped on the second run.
		expect(files.every((file) => file.endsWith("!") && !file.endsWith("!!"))).toBe(true);
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "ready" });
	});

	it("a refused commit (the activation abandoned) stops the migration between chunks", async () => {
		await filled(MIGRATION_CHUNK * 2 + 1);
		let admitted = 2;
		const fence = { admit: () => admitted-- > 0, adopt: () => {} };
		const migration = prepareTables([{ definition: EditsV2, table: TABLE }], store, fence, "app.store", context);
		expect(await rejection(migration)).toMatchObject({ code: "released" });
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "migrating" });
	});
});

describe("refusals", () => {
	it.each<[string, () => Promise<unknown>, string]>([
		["a newer version recorded", async () => prepared(EditsV1), "newer than the code's 1"],
		[
			"a version below the history's base",
			async () => prepared(defineTable("edits", { version: 7, columns: { id: str() }, key: ["id"] })),
			"older than the history's base 7",
		],
		[
			"a history edited in place",
			async () => prepared(evolveTable(EditsV1, (t) => t.rename("file", "name"))),
			"recorded with another definition",
		],
	])("%s (the store at version 2) throws before anything is written", async (_, prepare, message) => {
		await filled(1);
		await prepared(EditsV2);
		const seq = store.lastSeq;
		expect(await rejection(prepare())).toMatchObject({ message: expect.stringContaining(message) });
		expect(store.lastSeq).toBe(seq);
	});
});
