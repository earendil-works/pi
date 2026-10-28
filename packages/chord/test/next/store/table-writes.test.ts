// Table writes (slice 6a §6, §9): schema writes, row writes as the outbox records them, and alter writes.

import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { add, eq, prefix, replacePrefix } from "../../../src/next/store/expression.ts";
import { json } from "../../../src/next/store/json-column.ts";
import { query } from "../../../src/next/store/query.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import type { TableEdit } from "../../../src/next/store/table-history.ts";
import { stageEdit, stageIndex } from "../../../src/next/store/table-writes.ts";
import { memoryStore, metered, tableIn } from "../support.ts";

const Edits = defineTable("edits", {
	version: 2,
	columns: {
		id: str(),
		path: str(),
		hits: int({ default: 0 }),
		note: opt(str()),
		meta: opt(json(obj({}), { version: 3 })),
	},
	key: ["id"],
	indexes: { by_path: ["path"] },
});
const TABLE = "app.store:edits";
const FENCE = { admit: () => true, adopt: () => {} };

let store: ChordStore;
afterEach(async () => {
	await store?.close(context);
});

async function commitWith(fill: (changes: TableChanges) => void): Promise<void> {
	const staged: StagedWrite[] = [];
	fill(new TableChanges(handle, staged));
	await store.commit(staged, FENCE, context);
}

let handle: Awaited<ReturnType<typeof tableIn>>;

async function opened(): Promise<void> {
	store = await memoryStore({ outbox: true });
	handle = await tableIn(store, Edits);
}

describe("schema writes", () => {
	it("record the table and its indexes; the table write carries version, state, columns, key, fingerprint", async () => {
		await opened();
		const [commit] = await store.outbox!.read(0, 1, context);
		expect(commit!.writes).toEqual([
			{
				kind: "table",
				table: TABLE,
				version: 2,
				state: "ready",
				columns: Edits.record,
				key: ["id"],
				fingerprint: Edits.fingerprint,
			},
			{ kind: "index", table: TABLE, name: "by_path", columns: ["path"] },
		]);
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "ready", indexes: { by_path: ["path"] } });
		const indexes = await store.read(
			(executor) => executor.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`, TABLE),
			context,
		);
		expect(indexes).toContainEqual({ name: `${TABLE}:by_path` });
	});

	it("an index write for a table the store does not have refuses the step (D4: the store goes on)", async () => {
		await opened();
		const write = stageIndex({ kind: "index", table: "app.store:nope", name: "x", columns: ["id"] });
		await expect(store.commit([write], FENCE, context)).rejects.toThrow("not in the store");
		expect(await store.read(async () => 1, context)).toBe(1);
	});
});

describe("row writes in the outbox", () => {
	it("carry what a replica needs: put with v and json versions, update and delete with counts, the canonical set", async () => {
		await opened();
		await commitWith((changes) => {
			changes.put({ id: "a", path: "x/1", meta: {} });
			changes.put({ id: "b", path: "x/2" });
			changes.update({ id: "a" }, (e: { hits: never }) => ({ hits: add(e.hits, 1), note: undefined, meta: {} }));
			changes.update({ id: "zz" }, { note: "n" });
			changes.delete({ id: "b" });
			changes.delete({ id: "b" });
		});
		const [, commit] = await store.outbox!.read(0, 10, context);
		expect(commit!.writes).toEqual([
			{
				kind: "put",
				table: TABLE,
				row: { id: "a", path: "x/1", hits: 0, meta: {} },
				version: 2,
				columns: { meta: 3 },
			},
			{ kind: "put", table: TABLE, row: { id: "b", path: "x/2", hits: 0 }, version: 2, columns: {} },
			{
				kind: "update",
				table: TABLE,
				key: { id: "a" },
				set: { hits: { add: [{ col: "hits" }, 1] }, note: null, meta: { json: {} } },
				columns: { meta: 3 },
				count: 1,
			},
			{ kind: "update", table: TABLE, key: { id: "zz" }, set: { note: "n" }, columns: {}, count: 0 },
			{ kind: "delete", table: TABLE, key: { id: "b" }, count: 1 },
			{ kind: "delete", table: TABLE, key: { id: "b" }, count: 0 },
		]);
	});

	it("a put is an upsert: the whole row replaced", async () => {
		await opened();
		await commitWith((changes) => changes.put({ id: "a", path: "x", hits: 5, note: "n" }));
		await commitWith((changes) => changes.put({ id: "a", path: "y" }));
		expect(await handle.get({ id: "a" }, context)).toEqual({ id: "a", path: "y", hits: 0 });
	});

	it("updateWhere and deleteWhere are one statement each, recorded with where, set and count", async () => {
		await opened();
		await commitWith((changes) => {
			for (let i = 0; i < 5; i++) changes.put({ id: `e${i}`, path: i < 3 ? `a/${i}` : `b/${i}` });
		});
		const { counts, context: counting } = await metered();
		const staged: StagedWrite[] = [];
		const changes = new TableChanges(handle, staged);
		changes.updateWhere(
			(e: { path: never }) => prefix(e.path, "a/"),
			(e: { path: never }) => ({ path: replacePrefix(e.path, "a/", "c/") }),
		);
		changes.deleteWhere((e: { path: never }) => eq(e.path, "b/4"));
		await store.commit(staged, FENCE, counting);
		// The two bulk writes, the outbox commit, lastSeq.
		expect(counts()["chord.store.statements"]).toBe(4);
		const [, , commit] = await store.outbox!.read(0, 10, context);
		expect(commit!.writes).toEqual([
			{
				kind: "updateWhere",
				table: TABLE,
				where: { prefix: ["path", "a/"] },
				set: { path: { replacePrefix: [{ col: "path" }, "a/", "c/"] } },
				columns: {},
				count: 3,
			},
			{ kind: "deleteWhere", table: TABLE, where: { eq: ["path", "b/4"] }, count: 1 },
		]);
		expect((await handle.page(query(Edits), 10, context)).items.map((r) => r.path)).toEqual([
			"c/0",
			"c/1",
			"c/2",
			"b/3",
		]);
	});
});

describe("alter writes", () => {
	/** Applies `edits` to the edits table as the migration to version 3 does, one commit. */
	async function altered(...edits: TableEdit[]): Promise<void> {
		await store.commit(
			edits.map((edit) => stageEdit(TABLE, 3, edit)),
			FENCE,
			context,
		);
	}

	/** The physical columns of the edits table. */
	async function physical(): Promise<string[]> {
		const rows = await store.read(
			(executor) => executor.all<{ readonly name: string }>(`SELECT name FROM pragma_table_info('${TABLE}')`),
			context,
		);
		return rows.map(({ name }) => name);
	}

	it("rename a column: a json(...) one's version column, the key and the indexes follow", async () => {
		await opened();
		await commitWith((changes) => changes.put({ id: "a", path: "p" }));
		await altered({ kind: "rename", from: "meta", to: "info" }, { kind: "rename", from: "path", to: "file" });
		expect(await physical()).toEqual(["id", "file", "hits", "note", "info", "info$v", "$v"]);
		expect(store.table(TABLE)).toMatchObject({ indexes: { by_path: ["file"] } });
		expect(Object.keys(store.table(TABLE)!.columns)).toEqual(["id", "file", "hits", "note", "info"]);
	});

	it("add a column: existing rows get its default; an opt(...) json(...) one adds its version column", async () => {
		await opened();
		await commitWith((changes) => changes.put({ id: "a", path: "p" }));
		await altered(
			{ kind: "add", name: "level", column: { type: "int", default: 3 } },
			{ kind: "add", name: "extra", column: { type: "json", optional: true, version: 1, fingerprint: "f" } },
		);
		expect(await physical()).toEqual([
			"id",
			"path",
			"hits",
			"note",
			"meta",
			"meta$v",
			"$v",
			"level",
			"extra",
			"extra$v",
		]);
		const rows = await store.read((executor) => executor.all(`SELECT level FROM "${TABLE}"`), context);
		expect(rows).toEqual([{ level: 3 }]);
		expect(store.table(TABLE)!.columns.level).toEqual({ type: "int", default: 3 });
	});

	it("drop a column (with its version column); a json edit changes the record only", async () => {
		await opened();
		await commitWith((changes) => changes.put({ id: "a", path: "p" }));
		const column = { type: "json", optional: true, version: 4, fingerprint: "g" } as const;
		await altered({ kind: "drop", name: "note" }, { kind: "json", name: "meta", column });
		expect(await physical()).toEqual(["id", "path", "hits", "meta", "meta$v", "$v"]);
		expect(store.table(TABLE)!.columns.meta).toEqual(column);
		await altered({ kind: "drop", name: "meta" });
		expect(await physical()).toEqual(["id", "path", "hits", "$v"]);
	});

	it("are recorded as alter writes with the migration's version; index edits as index and dropIndex", async () => {
		await opened();
		const seq = store.lastSeq;
		await altered({ kind: "dropIndex", name: "by_path" }, { kind: "drop", name: "path" });
		const [commit] = await store.outbox!.read(seq, 1, context);
		expect(commit!.writes).toEqual([
			{ kind: "dropIndex", table: TABLE, name: "by_path" },
			{ kind: "alter", table: TABLE, version: 3, edit: { kind: "drop", name: "path" } },
		]);
	});
});
