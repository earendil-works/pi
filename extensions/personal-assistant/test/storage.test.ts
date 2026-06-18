import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryIndex } from "../storage.ts";

// Minimal shape of rows returned by sqlite_master / PRAGMA queries.
// better-sqlite3 returns columns as JS values; the driver exposes ints as
// numbers, TEXT as strings, and unknown columns as null/undefined.
interface NameRow {
	name: string;
}
interface SqlRow {
	sql: string | null;
}
interface ColumnInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: unknown;
	pk: number;
}

// Smoke helper: open a fresh in-memory MemoryIndex and call init(). Returns
// the index so individual tests can inspect it; the afterEach hook closes it.
function freshIndex(): MemoryIndex {
	const idx = new MemoryIndex(":memory:");
	return idx;
}

describe("MemoryIndex", () => {
	describe("init creates all tables", () => {
		let idx: MemoryIndex;

		beforeEach(() => {
			idx = freshIndex();
		});

		afterEach(() => {
			idx.close();
		});

		it("init creates memory_index table with correct columns", async () => {
			await idx.init();

			const db = idx.getRawDb();

			// The memory_index table must exist.
			const tables = db.prepare(
				"SELECT name FROM sqlite_master WHERE type IN ('table') AND name = 'memory_index'",
			).all() as NameRow[];
			expect(tables).toHaveLength(1);
			expect(tables[0]?.name).toBe("memory_index");

			// All 19 columns must be present. We assert the column set, not
			// the order, so future schema additions stay orthogonal to this
			// assertion as long as we update the expected set.
			const cols = db.prepare("PRAGMA table_info(memory_index)").all() as ColumnInfoRow[];
			const names = cols.map((c) => c.name).sort();
			expect(names).toEqual([
				"access_count",
				"archived",
				"content",
				"content_fingerprint",
				"created_at",
				"id",
				"importance",
				"is_latest",
				"last_access",
				"parent_id",
				"source_session",
				"strength",
				"summary",
				"superseded_at",
				"tags",
				"title",
				"type",
				"updated_at",
				"version",
			]);

			// Sanity: `id` is the PRIMARY KEY (pk = 1 in PRAGMA output).
			const idCol = cols.find((c) => c.name === "id");
			expect(idCol?.pk).toBe(1);
		});

		it("init creates memory_vectors virtual table", async () => {
			await idx.init();

			const db = idx.getRawDb();

			// The virtual table must exist and use vec0 with FLOAT[1024] —
			// these are the only verifiable contracts: schema presence and
			// dimension. Future phases will exercise KNN against it.
			const row = db.prepare(
				"SELECT name, sql FROM sqlite_master WHERE name = 'memory_vectors'",
			).get() as (NameRow & SqlRow) | undefined;
			expect(row).toBeDefined();
			expect(row?.name).toBe("memory_vectors");
			const sql = row?.sql ?? "";
			expect(sql).toContain("VIRTUAL TABLE");
			expect(sql).toContain("vec0");
			expect(sql).toContain("FLOAT[1024]");
		});

		it("init creates memory_audit table", async () => {
			await idx.init();

			const db = idx.getRawDb();

			const tables = db.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_audit'",
			).all() as NameRow[];
			expect(tables).toHaveLength(1);
			expect(tables[0]?.name).toBe("memory_audit");

			// memory_audit has at least the 4 documented columns.
			const cols = db.prepare("PRAGMA table_info(memory_audit)").all() as ColumnInfoRow[];
			const names = cols.map((c) => c.name).sort();
			expect(names).toEqual(["action", "atom_id", "created_at", "details", "id"]);
		});

		it("init creates 5 indexes including UNIQUE active fingerprint", async () => {
			await idx.init();

			const db = idx.getRawDb();

			// Exactly the 5 expected indexes must be present. Using
			// `LIKE 'idx_memory%'` excludes sqlite-vec's internal indexes,
			// which start with different prefixes.
			const rows = db.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_memory%' ORDER BY name",
			).all() as NameRow[];
			expect(rows.map((r) => r.name)).toEqual([
				"idx_memory_active_fingerprint",
				"idx_memory_active_recent",
				"idx_memory_audit_atom",
				"idx_memory_superseded",
				"idx_memory_type",
			]);

			// The fingerprint index is partial (active rows only) AND UNIQUE
			// — Decision 5 / R3 in the design doc: prevents concurrent
			// duplicate writes of the same content among active atoms.
			const fpRow = db.prepare(
				"SELECT sql FROM sqlite_master WHERE name = 'idx_memory_active_fingerprint'",
			).get() as SqlRow | undefined;
			expect(fpRow?.sql).toBeDefined();
			const sql = fpRow?.sql ?? "";
			expect(sql).toContain("UNIQUE");
			expect(sql).toContain("content_fingerprint");
			expect(sql).toContain("is_latest = 1");
			expect(sql).toContain("archived = 0");
		});

		it("close prevents further queries", async () => {
			await idx.init();

			const db = idx.getRawDb();
			// Sanity: open connection responds.
			expect(db.prepare("SELECT 1 AS v").get()).toEqual({ v: 1 });

			idx.close();

			// After close, any prepare or execute must throw. We do not assert
			// on the specific error message because better-sqlite3's wording
			// is implementation-defined; only that subsequent calls fail.
			expect(() => db.prepare("SELECT 1").all()).toThrow();
		});

		it("init is idempotent — calling twice does not fail", async () => {
			await idx.init();
			await expect(idx.init()).resolves.toBeUndefined();

			// After double-init the schema is still consistent (one of each
			// table, five of our indexes).
			const db = idx.getRawDb();
			const tables = db.prepare(
				"SELECT name FROM sqlite_master WHERE type IN ('table') AND name IN ('memory_index', 'memory_audit')",
			).all() as NameRow[];
			expect(tables).toHaveLength(2);
			const vec = db.prepare(
				"SELECT name FROM sqlite_master WHERE name = 'memory_vectors'",
			).all() as NameRow[];
			expect(vec).toHaveLength(1);
			const indexes = db.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_memory%'",
			).all() as NameRow[];
			expect(indexes).toHaveLength(5);
		});
	});
});