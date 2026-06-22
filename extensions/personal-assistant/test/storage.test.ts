import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom } from "../types.ts";

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

	describe("atom CRUD", () => {
		let index: MemoryIndex;

		beforeEach(async () => {
			index = freshIndex();
			await index.init();
		});

		afterEach(() => {
			index.close();
		});

		const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
			id: randomUUID(),
			type: "rule",
			title: "t",
			content: "c",
			summary: "s",
			tags: ["a"],
			importance: 0.5,
			strength: 0.5,
			access_count: 0,
			version: 1,
			is_latest: 1,
			parent_id: null,
			superseded_at: null,
			archived: 0,
			created_at: Date.now(),
			updated_at: Date.now(),
			last_access: null,
			content_fingerprint: "fp",
			source_session: null,
			...overrides,
		});

		const dummyEmbedding = (): number[] => new Array(1024).fill(0.01);

		it("insertAtom stores row + vector, getAtom retrieves it", async () => {
			const atom = sampleAtom();
			await index.insertAtom(atom, dummyEmbedding());
			const got = index.getAtom(atom.id);
			expect(got).toEqual(atom);
		});

		it("insertAtom with duplicate fingerprint on active atom throws UNIQUE", async () => {
			const atom1 = sampleAtom({ id: randomUUID(), content_fingerprint: "fp1" });
			await index.insertAtom(atom1, dummyEmbedding());
			const atom2 = sampleAtom({ id: randomUUID(), content_fingerprint: "fp1" });
			await expect(index.insertAtom(atom2, dummyEmbedding())).rejects.toThrow();
		});

		it("updateAtom increments version and updates fields", async () => {
			const atom = sampleAtom();
			await index.insertAtom(atom, dummyEmbedding());
			const updated: MemoryAtom = {
				...atom,
				title: "new title",
				version: atom.version + 1,
				updated_at: Date.now() + 1000,
			};
			await index.updateAtom(updated);
			const got = index.getAtom(atom.id);
			expect(got?.title).toBe("new title");
			expect(got?.version).toBe(2);
		});

		it("updateAtom recomputes vector when embedding provided", async () => {
			const atom = sampleAtom();
			await index.insertAtom(atom, dummyEmbedding());
			const newEmb: number[] = new Array(1024).fill(0.99);
			await index.updateAtom(atom, newEmb);
			const row = index
				.getRawDb()
				.prepare(`SELECT embedding FROM memory_vectors WHERE id = ?`)
				.get(atom.id) as { embedding: Buffer };
			const arr = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, 1024);
			expect(arr[0]).toBeCloseTo(0.99, 5);
		});

		it("getActiveAtomByFingerprint returns active+latest matching atom", async () => {
			const atom = sampleAtom({ content_fingerprint: "fp-unique" });
			await index.insertAtom(atom, dummyEmbedding());
			const got = index.getActiveAtomByFingerprint("fp-unique");
			expect(got?.id).toBe(atom.id);
		});

		it("getActiveAtomByFingerprint returns null if archived or superseded", async () => {
			const atom = sampleAtom({ content_fingerprint: "fp-arc", archived: 1 });
			await index.insertAtom(atom, dummyEmbedding());
			expect(index.getActiveAtomByFingerprint("fp-arc")).toBeNull();
		});

		it("getActiveAtoms returns all active atoms, excludes archived/superseded", async () => {
			const a1 = sampleAtom({ id: randomUUID(), content_fingerprint: "fp-a1" });
			const a2 = sampleAtom({ id: randomUUID(), content_fingerprint: "fp-a2", is_latest: 0 });
			const a3 = sampleAtom({ id: randomUUID(), content_fingerprint: "fp-a3", archived: 1 });
			await index.insertAtom(a1, dummyEmbedding());
			await index.insertAtom(a2, dummyEmbedding());
			await index.insertAtom(a3, dummyEmbedding());
			const active = index.getActiveAtoms();
			expect(active.map((a) => a.id)).toEqual([a1.id]);
		});

		it("getActiveAtomsByType filters correctly", async () => {
			const rule = sampleAtom({ type: "rule", content_fingerprint: "fp-r" });
			const fact = sampleAtom({ type: "fact", content_fingerprint: "fp-f" });
			await index.insertAtom(rule, dummyEmbedding());
			await index.insertAtom(fact, dummyEmbedding());
			const rules = index.getActiveAtomsByType("rule");
			expect(rules.map((a) => a.id)).toEqual([rule.id]);
		});
	});

	describe("vector search", () => {
		let index: MemoryIndex;

		beforeEach(async () => {
			index = new MemoryIndex(":memory:");
			await index.init();
		});

		afterEach(() => {
			index.close();
		});

		const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
			id: randomUUID(),
			type: "rule",
			title: "t",
			content: "c",
			summary: "s",
			tags: ["a"],
			importance: 0.5,
			strength: 0.5,
			access_count: 0,
			version: 1,
			is_latest: 1,
			parent_id: null,
			superseded_at: null,
			archived: 0,
			created_at: Date.now(),
			updated_at: Date.now(),
			last_access: null,
			content_fingerprint: randomUUID().slice(0, 16),
			source_session: null,
			...overrides,
		});

		const randomVec = (seed: number): number[] => {
			const arr = new Array(1024).fill(0);
			let s = seed;
			for (let i = 0; i < 1024; i++) {
				s = (s * 1103515245 + 12345) & 0x7fffffff;
				arr[i] = (s / 0x7fffffff) * 2 - 1;
			}
			const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
			return arr.map((v) => v / norm);
		};

		it("vectorSearch returns K nearest by L2 distance", async () => {
			const a1 = sampleAtom({ id: "a1", content_fingerprint: "fp1", type: "rule" });
			const a2 = sampleAtom({ id: "a2", content_fingerprint: "fp2", type: "fact" });
			await index.insertAtom(a1, randomVec(1));
			await index.insertAtom(a2, randomVec(2));
			const results = index.vectorSearch(randomVec(1), 10);
			expect(results.length).toBe(2);
			expect(results[0].id).toBe("a1");
			expect(results[0].distance).toBeCloseTo(0, 1);
		});

		it("vectorSearch filters by type", async () => {
			const r = sampleAtom({ id: "r1", content_fingerprint: "fr1", type: "rule" });
			const f = sampleAtom({ id: "f1", content_fingerprint: "ff1", type: "fact" });
			await index.insertAtom(r, randomVec(10));
			await index.insertAtom(f, randomVec(20));
			const results = index.vectorSearch(randomVec(10), 10, { type: "rule" });
			expect(results.length).toBe(1);
			expect(results[0].id).toBe("r1");
		});

		it("vectorSearch excludes archived and superseded by default", async () => {
			const a = sampleAtom({ id: "a", content_fingerprint: "fa" });
			const arch = sampleAtom({
				id: "arch",
				content_fingerprint: "farch",
				archived: 1,
			});
			const sup = sampleAtom({
				id: "sup",
				content_fingerprint: "fsup",
				is_latest: 0,
			});
			await index.insertAtom(a, randomVec(100));
			await index.insertAtom(arch, randomVec(200));
			await index.insertAtom(sup, randomVec(300));
			const results = index.vectorSearch(randomVec(100), 10);
			expect(results.map((r) => r.id)).toEqual(["a"]);
		});

		it("findMostSimilarEmbedding returns top-1 if cosine > threshold", async () => {
			const a = sampleAtom({ id: "match", content_fingerprint: "fmatch" });
			await index.insertAtom(a, randomVec(42));
			const result = index.findMostSimilarEmbedding(randomVec(42), 0.9);
			expect(result).not.toBeNull();
			expect(result!.atom.id).toBe("match");
			expect(result!.cosine).toBeCloseTo(1.0, 2);
		});

		it("findMostSimilarEmbedding returns null if cosine < threshold", async () => {
			const a = sampleAtom({ id: "x", content_fingerprint: "fx" });
			await index.insertAtom(a, randomVec(1));
			const result = index.findMostSimilarEmbedding(randomVec(999), 0.99);
			expect(result).toBeNull();
		});

		it("cosineSimilarity returns 1.0 for identical vectors", () => {
			const v = randomVec(5);
			expect(index.cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
		});
	});

	describe("supersede transaction", () => {
		let index: MemoryIndex;

		beforeEach(async () => {
			index = new MemoryIndex(":memory:");
			await index.init();
		});

		afterEach(() => {
			index.close();
		});

		const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
			id: randomUUID(),
			type: "rule",
			title: "t",
			content: "c",
			summary: "s",
			tags: ["a"],
			importance: 0.5,
			strength: 0.5,
			access_count: 0,
			version: 1,
			is_latest: 1,
			parent_id: null,
			superseded_at: null,
			archived: 0,
			created_at: Date.now(),
			updated_at: Date.now(),
			last_access: null,
			content_fingerprint: randomUUID().slice(0, 16),
			source_session: null,
			...overrides,
		});

		const dummyEmbedding = (): number[] => new Array(1024).fill(0.01);

		it("markSupersededTx atomically marks old as superseded and inserts new", async () => {
			const old = sampleAtom({ id: "old", access_count: 5, strength: 0.8 });
			await index.insertAtom(old, dummyEmbedding());
			const newAtom = sampleAtom({ id: "new", access_count: 0, strength: 0.5 });
			const result = index.markSupersededTx("old", newAtom, dummyEmbedding());
			expect(result.oldAtom.id).toBe("old");
			expect(result.newAtom.id).toBe("new");
			const oldAfter = index.getAtom("old");
			expect(oldAfter?.is_latest).toBe(0);
			expect(oldAfter?.superseded_at).not.toBeNull();
			const newAfter = index.getAtom("new");
			expect(newAfter?.is_latest).toBe(1);
			expect(newAfter?.parent_id).toBe("old");
		});

		it("transfers access_count, strength, created_at from old to new", async () => {
			const oldTime = Date.now() - 10000;
			const old = sampleAtom({
				id: "old",
				access_count: 7,
				strength: 0.9,
				created_at: oldTime,
			});
			await index.insertAtom(old, dummyEmbedding());
			const newAtom = sampleAtom({
				id: "new",
				access_count: 0,
				strength: 0.5,
				created_at: Date.now(),
			});
			const { newAtom: result } = index.markSupersededTx("old", newAtom, dummyEmbedding());
			expect(result.access_count).toBe(7);
			expect(result.strength).toBe(0.9);
			expect(result.created_at).toBe(oldTime);
			expect(result.version).toBe(1);
		});

		it("newAtom.importance takes max(old.importance, new.importance)", async () => {
			const old = sampleAtom({ id: "old", importance: 0.3 });
			await index.insertAtom(old, dummyEmbedding());
			const newA = sampleAtom({ id: "na", importance: 0.9 });
			const r1 = index.markSupersededTx("old", newA, dummyEmbedding());
			expect(r1.newAtom.importance).toBeCloseTo(0.9, 5);
		});

		it("rolls back if any operation in transaction fails", async () => {
			const old = sampleAtom({ id: "old", content_fingerprint: "fp-old-rollback" });
			await index.insertAtom(old, dummyEmbedding());
			// newAtom with duplicate fingerprint should fail INSERT (UNIQUE index)
			const newAtom = sampleAtom({ id: "new", content_fingerprint: "fp-other-active" });
			await index.insertAtom(newAtom, dummyEmbedding()); // takes the fingerprint
			const newAtom2 = sampleAtom({
				id: "new2",
				content_fingerprint: "fp-other-active",
			});
			expect(() => index.markSupersededTx("old", newAtom2, dummyEmbedding())).toThrow();
			// old should still be is_latest=1 (transaction rolled back)
			expect(index.getAtom("old")?.is_latest).toBe(1);
		});

		it("writes audit entries for both atoms", async () => {
			const old = sampleAtom({ id: "old" });
			await index.insertAtom(old, dummyEmbedding());
			const newAtom = sampleAtom({ id: "new" });
			index.markSupersededTx("old", newAtom, dummyEmbedding());
			const oldAudit = index.getAudit("old");
			const newAudit = index.getAudit("new");
			expect(oldAudit.some((a) => a.action === "superseded")).toBe(true);
			expect(newAudit.some((a) => a.action === "created_from_supersede")).toBe(true);
		});
	});

	describe("access and decay", () => {
		let index: MemoryIndex;

		beforeEach(async () => {
			index = new MemoryIndex(":memory:");
			await index.init();
		});

		afterEach(() => {
			index.close();
		});

		const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
			id: randomUUID(),
			type: "rule",
			title: "t",
			content: "c",
			summary: "s",
			tags: ["a"],
			importance: 0.5,
			strength: 0.5,
			access_count: 0,
			version: 1,
			is_latest: 1,
			parent_id: null,
			superseded_at: null,
			archived: 0,
			created_at: Date.now(),
			updated_at: Date.now(),
			last_access: null,
			content_fingerprint: randomUUID().slice(0, 16),
			source_session: null,
			...overrides,
		});

		const dummyEmbedding = (): number[] => new Array(1024).fill(0.01);

		it("updateAccess increments access_count and sets last_access", async () => {
			const atom = sampleAtom({ id: "a" });
			await index.insertAtom(atom, dummyEmbedding());
			const before = Date.now();
			index.updateAccess("a");
			const after = Date.now();
			const got = index.getAtom("a");
			expect(got?.access_count).toBe(1);
			expect(got?.last_access).toBeGreaterThanOrEqual(before);
			expect(got?.last_access).toBeLessThanOrEqual(after);
		});

		it("updateAccess increments multiple times", async () => {
			const atom = sampleAtom({ id: "a" });
			await index.insertAtom(atom, dummyEmbedding());
			index.updateAccess("a");
			index.updateAccess("a");
			index.updateAccess("a");
			expect(index.getAtom("a")?.access_count).toBe(3);
		});

		it("updateStrength sets new strength value", async () => {
			const atom = sampleAtom({ id: "a", strength: 0.5 });
			await index.insertAtom(atom, dummyEmbedding());
			index.updateStrength("a", 0.2);
			expect(index.getAtom("a")?.strength).toBeCloseTo(0.2, 5);
		});

		it("markArchived sets archived=1 and writes audit entry", async () => {
			const atom = sampleAtom({ id: "a" });
			await index.insertAtom(atom, dummyEmbedding());
			index.markArchived("a");
			expect(index.getAtom("a")?.archived).toBe(1);
			const audit = index.getAudit("a");
			expect(audit.some((a) => a.action === "archived")).toBe(true);
		});

		it("markUnarchived restores archived=0 (no audit)", async () => {
			const atom = sampleAtom({ id: "a", archived: 1 });
			await index.insertAtom(atom, dummyEmbedding());
			// Pre-existing audit baseline so we can detect a (forbidden) new entry.
			const baselineAuditCount = index.getAudit("a").length;
			index.markUnarchived("a");
			expect(index.getAtom("a")?.archived).toBe(0);
			expect(index.getAudit("a").length).toBe(baselineAuditCount);
		});

		it("deleteVector removes the embedding from memory_vectors", async () => {
			const atom = sampleAtom({ id: "a" });
			await index.insertAtom(atom, dummyEmbedding());
			// Confirm vector exists
			const before = index.getRawDb().prepare(`SELECT 1 FROM memory_vectors WHERE id = ?`).get("a");
			expect(before).toBeDefined();
			index.deleteVector("a");
			const after = index.getRawDb().prepare(`SELECT 1 FROM memory_vectors WHERE id = ?`).get("a");
			expect(after).toBeUndefined();
		});
	});
});