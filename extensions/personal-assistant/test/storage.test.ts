import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

		it("markSupersededTx swaps memory_fts row", async () => {
			// Scenario "supersedeAtom swaps the memory_fts row": when A is
			// superseded by B inside markSupersededTx, the memory_fts row
			// for A must be deleted and the row for B inserted in the same
			// transaction. Use pure-alnum tokens (no hyphens, no special
			// chars) so a bm25 MATCH hits ONLY the intended row — the FTS5
			// unicode61 tokenizer splits on hyphens, and a hyphenated query
			// like "title-A-oldunique" would be parsed as column syntax
			// rather than a literal term.
			const old = sampleAtom({
				id: "A",
				title: "titleoldxyz",
				summary: "summaryoldxyz",
				content: "contentoldxyz",
				tags: ["tagoldxyz"],
			});
			await index.insertAtom(old, dummyEmbedding());

			// Pre-condition sanity: insertAtom writes memory_fts row for A.
			// If this fails, the test premise (A has a row to delete) is
			// invalid and the rest of the assertions are meaningless.
			const db = index.getRawDb();
			const preOldCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get("A") as { c: number };
			expect(preOldCount.c).toBe(1);

			const newAtom = sampleAtom({
				id: "B",
				title: "titlenewxyz",
				summary: "summarynewxyz",
				content: "contentnewxyz",
				tags: ["tagnewxyz"],
			});
			index.markSupersededTx("A", newAtom, dummyEmbedding());

			// 1. Old atom's memory_fts row is gone (transaction DELETEd it).
			const oldCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get("A") as { c: number };
			expect(oldCount.c).toBe(0);

			// 2. New atom's memory_fts row is present (transaction INSERTed it).
			const newCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get("B") as { c: number };
			expect(newCount.c).toBe(1);

			// 3. bm25Search for old atom's tokens must NOT return A. The
			// is_latest filter alone would block A, but this assertion is
			// the visible behaviour contract — prove the row is truly gone
			// (the count check above is the structural assertion; this is
			// the user-facing one).
			const oldHits = index.bm25Search("titleoldxyz", 10);
			expect(oldHits.map((r) => r.id)).not.toContain("A");

			// 4. bm25Search for new atom's tokens MUST return B. This proves
			// the new FTS5 row landed AND is searchable — not just present
			// in count(*) terms.
			const newHits = index.bm25Search("titlenewxyz", 10);
			expect(newHits.map((r) => r.id)).toContain("B");
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

		it("markArchived deletes memory_fts row", async () => {
			// Scenario "archiveAtom removes the memory_fts row": when an atom
			// is archived, the FTS5 mirror row must be dropped in the same
			// transaction so a subsequent bm25Search cannot surface an
			// archived atom. Principle: "archive / supersede 立即让 FTS5 行失效".
			//
			// The bm25Search query uses a pure alnum token — FTS5 unicode61
			// tokenizes on whitespace + punctuation, and the escapeFtsQuery
			// helper only strips `"()*:[]`. A hyphenated term like
			// "title-arc-unique" would be parsed as a column-restricted
			// query (`title-arc`) and fail with "no such column: arc"; an
			// alnum suffix is the safe cross-test pattern (see the sibling
			// "markSupersededTx swaps memory_fts row" test).
			const atom = sampleAtom({
				id: "arc-1",
				title: "titlearcunique",
				summary: "summaryarcunique",
				content: "contentarcunique",
				tags: ["tagarcunique"],
			});
			await index.insertAtom(atom, dummyEmbedding());

			// Pre-condition sanity: insertAtom wrote the FTS5 row. If this
			// fails, the test premise (a row exists to delete) is invalid
			// and the rest of the assertions are meaningless.
			const db = index.getRawDb();
			const preCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get("arc-1") as { c: number };
			expect(preCount.c).toBe(1);

			index.markArchived("arc-1");

			// 1. FTS5 row count for the archived atom is zero — the structural
			// assertion that the row was DELETEd in the same transaction.
			const postCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get("arc-1") as { c: number };
			expect(postCount.c).toBe(0);

			// 2. bm25Search for the archived atom's tokens must NOT return
			// the id. This is the user-facing behaviour contract: prove the
			// row is truly gone (not just hidden by the is_latest filter).
			const hits = index.bm25Search("titlearcunique", 10);
			expect(hits.map((r) => r.id)).not.toContain("arc-1");
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

	describe("constructor self-heals missing parent directory", () => {
		// Regression: deleting ~/.pi/agent/memory/ (or installing onto a fresh
		// machine) used to make every subsequent MemoryIndex construction fail
		// with SQLITE_CANTOPEN. better-sqlite3 does not create the parent
		// directory of a file-backed DB; the storage layer must.
		let tmpRoot: string;

		beforeEach(() => {
			tmpRoot = mkdtempSync(join(tmpdir(), "memory-index-selfheal-"));
		});

		afterEach(() => {
			rmSync(tmpRoot, { recursive: true, force: true });
		});

		it("creates nested parent directory and opens DB on first construction", async () => {
			const dbPath = join(tmpRoot, "deeply", "nested", "memory.db");
			expect(existsSync(join(tmpRoot, "deeply"))).toBe(false);

			const idx = new MemoryIndex(dbPath);
			try {
				await idx.init();
				expect(existsSync(dbPath)).toBe(true);
				const tables = idx.getRawDb()
					.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
					.all() as NameRow[];
				const tableNames = tables.map((t) => t.name);
				expect(tableNames).toContain("memory_index");
			} finally {
				idx.close();
			}
		});

		it("does not touch filesystem for :memory: databases", () => {
			// In-memory DBs have no parent dir to create; the constructor must
			// not call mkdir (would throw on a non-directory dbPath like ":memory:").
			const idx = new MemoryIndex(":memory:");
			try {
				expect(idx).toBeInstanceOf(MemoryIndex);
			} finally {
				idx.close();
			}
		});
	});

	describe("memory_fts FTS5 table", () => {
		// memory_fts is the FTS5 mirror of memory_index used for keyword recall.
		// It is created and backfilled in init() on first run; subsequent inits
		// are no-ops (idempotent). See docs/sdd/changes/memory-v2-refactor
		// (FTS5 schema and storage sync requirement).
		let idx: MemoryIndex;

		beforeEach(() => {
			idx = freshIndex();
		});

		afterEach(() => {
			idx.close();
		});

		it("init creates memory_fts table", async () => {
			await idx.init();

			const db = idx.getRawDb();
			const row = db.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'",
			).get() as NameRow | undefined;
			expect(row).toBeDefined();
			expect(row?.name).toBe("memory_fts");
		});

		it("init creates memory_fts virtual table with fts5 schema", async () => {
			await idx.init();

			const db = idx.getRawDb();
			// FTS5 virtual tables show up in sqlite_master with the original
			// CREATE VIRTUAL TABLE statement. Verify the fields and the
			// tokenizer; deliberately do NOT assert external-content mode
			// (`content=''`) because we need column values (notably `id`) to
			// be retrievable on SELECT for bm25Search's JOIN to work.
			const row = db.prepare(
				"SELECT sql FROM sqlite_master WHERE name = 'memory_fts'",
			).get() as SqlRow | undefined;
			expect(row).toBeDefined();
			const sql = row?.sql ?? "";
			expect(sql).toContain("VIRTUAL TABLE");
			expect(sql).toContain("fts5");
			expect(sql).toContain("id UNINDEXED");
			expect(sql).toContain("title");
			expect(sql).toContain("summary");
			expect(sql).toContain("content");
			expect(sql).toContain("tags");
			expect(sql).toContain("unicode61");
			// memory_fts must NOT use external-content mode: that mode makes
			// every column (including the UNINDEXED `id`) return NULL on
			// SELECT, which would break `bm25Search`'s
			// `INNER JOIN memory_index i ON v.id = i.id` join key.
			expect(sql).not.toMatch(/content\s*=\s*''/);
		});

		it("init backfills active atoms on existing DB without memory_fts", async () => {
			const db = idx.getRawDb();

			// Apply the base schema, then drop memory_fts so the next init()
			// must re-create it AND backfill. This simulates the upgrade path:
			// a DB that already has memory_index rows but never had memory_fts.
			await idx.init();
			db.exec("DROP TABLE memory_fts");
			expect(
				db.prepare("SELECT name FROM sqlite_master WHERE name='memory_fts'").get(),
			).toBeUndefined();

			// Insert 8 active atoms directly via raw SQL (bypassing insertAtom
			// so we control the exact pre-init state of memory_index).
			const insertAtom = db.prepare(`
				INSERT INTO memory_index (
					id, type, title, summary, content, tags, importance, strength,
					access_count, version, is_latest, parent_id, superseded_at, archived,
					created_at, updated_at, last_access, content_fingerprint, source_session
				) VALUES (
					@id, @type, @title, @summary, @content, @tags, @importance, @strength,
					@access_count, @version, @is_latest, @parent_id, @superseded_at, @archived,
					@created_at, @updated_at, @last_access, @content_fingerprint, @source_session
				)
			`);
			const insertVec = db.prepare(
				"INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)",
			);

			// Each atom gets a unique tag token (`tag0` … `tag7`) so we can
			// verify per-atom indexing via FTS5 MATCH. With `content=''`
			// (external-content mode), the FTS5 table does not store the
			// `id` column (UNINDEXED returns null on SELECT), so we cannot
			// join back to memory_index by id from the FTS5 side. MATCH on
			// a unique token is the reliable per-atom assertion.
			const tokens: string[] = [];
			for (let i = 0; i < 8; i++) {
				const id = `atom-${i}`;
				const token = `tag${i}`;
				insertAtom.run({
					id,
					type: "fact",
					title: `Title ${i}`,
					summary: `Summary ${i}`,
					content: `Content body ${i}`,
					tags: JSON.stringify([token, "common"]),
					importance: 0.5,
					strength: 0.5,
					access_count: 0,
					version: 1,
					is_latest: 1,
					parent_id: null,
					superseded_at: null,
					archived: 0,
					created_at: 1000 + i,
					updated_at: 1000 + i,
					last_access: null,
					content_fingerprint: `fp-${i}`,
					source_session: null,
				});
				insertVec.run(id, new Float32Array(1024));
				tokens.push(token);
			}

			// Now call init — should create memory_fts and backfill all 8 active atoms.
			await idx.init();

			// Total row count matches the 8 active atoms.
			const count = db.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as { c: number };
			expect(count.c).toBe(8);

			// Every atom's unique tag is findable via MATCH — proves each
			// atom's row landed in the FTS5 index (not just that the count
			// happened to be 8).
			for (const token of tokens) {
				const rows = db
					.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
					.all(token) as Array<{ rowid: number }>;
				expect(rows.length).toBe(1);
			}
		});

		it("init backfill filters out archived and superseded atoms", async () => {
			// Principles: "FTS5 行只描述 active 文本层(不含 embedding)" —
			// only active atoms (archived = 0 AND is_latest = 1) belong in
			// memory_fts.
			const db = idx.getRawDb();

			await idx.init();
			db.exec("DROP TABLE memory_fts");

			const insertAtom = db.prepare(`
				INSERT INTO memory_index (
					id, type, title, summary, content, tags, importance, strength,
					access_count, version, is_latest, parent_id, superseded_at, archived,
					created_at, updated_at, last_access, content_fingerprint, source_session
				) VALUES (
					@id, @type, @title, @summary, @content, @tags, @importance, @strength,
					@access_count, @version, @is_latest, @parent_id, @superseded_at, @archived,
					@created_at, @updated_at, @last_access, @content_fingerprint, @source_session
				)
			`);
			const insertVec = db.prepare(
				"INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)",
			);

			const seed = (
				id: string,
				fp: string,
				overrides: { is_latest?: number; archived?: number; token?: string } = {},
			): void => {
				// Default to a unique tag token so each atom is MATCH-findable.
				// Use a single alnum token (no hyphens) — FTS5 query syntax
				// treats `-` as a NOT operator, so hyphenated tokens break MATCH.
				const token = overrides.token ?? `${id}token`;
				insertAtom.run({
					id,
					type: "fact",
					title: id,
					summary: `s-${id}`,
					content: `c-${id}`,
					tags: JSON.stringify([token]),
					importance: 0.5,
					strength: 0.5,
					access_count: 0,
					version: 1,
					is_latest: overrides.is_latest ?? 1,
					parent_id: null,
					superseded_at: overrides.is_latest === 0 ? Date.now() : null,
					archived: overrides.archived ?? 0,
					created_at: 1000,
					updated_at: 1000,
					last_access: null,
					content_fingerprint: fp,
					source_session: null,
				});
				insertVec.run(id, new Float32Array(1024));
			};

			// 2 active, 1 archived, 1 superseded → backfill must include only the 2 active.
			seed("active1", "fp-act-1", { token: "active1token" });
			seed("active2", "fp-act-2", { token: "active2token" });
			seed("archived1", "fp-arc", { archived: 1, token: "archived1token" });
			seed("superseded1", "fp-sup", { is_latest: 0, token: "superseded1token" });

			await idx.init();

			const count = db.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as { c: number };
			expect(count.c).toBe(2);

			// Active atoms are findable.
			expect(
				(
					db
						.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
						.all("active1token") as Array<{ rowid: number }>
				).length,
			).toBe(1);
			expect(
				(
					db
						.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
						.all("active2token") as Array<{ rowid: number }>
				).length,
			).toBe(1);

			// Archived + superseded atoms are NOT findable.
			expect(
				db
					.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
					.all("archived1token"),
			).toEqual([]);
			expect(
				db
					.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
					.all("superseded1token"),
			).toEqual([]);
		});

		it("init is idempotent — second init does not duplicate rows", async () => {
			const db = idx.getRawDb();

			// First init on a fresh DB creates all tables including memory_fts.
			// memory_fts is empty here because memory_index has 0 active rows.
			await idx.init();

			// Drop memory_fts and seed 2 atoms. The next init() must create
			// memory_fts and backfill those 2 atoms. A subsequent init() must
			// NOT re-create or re-backfill (idempotent — same DB opened twice
			// should not produce duplicate rows).
			db.exec("DROP TABLE memory_fts");

			const insertAtom = db.prepare(`
				INSERT INTO memory_index (
					id, type, title, summary, content, tags, importance, strength,
					access_count, version, is_latest, parent_id, superseded_at, archived,
					created_at, updated_at, last_access, content_fingerprint, source_session
				) VALUES (
					@id, @type, @title, @summary, @content, @tags, @importance, @strength,
					@access_count, @version, @is_latest, @parent_id, @superseded_at, @archived,
					@created_at, @updated_at, @last_access, @content_fingerprint, @source_session
				)
			`);
			const insertVec = db.prepare(
				"INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)",
			);

			const seed = (id: string, fp: string): void => {
				// Tag token is alnum-only so FTS5 MATCH parses it cleanly
				// (FTS5 treats `-` as a NOT operator).
				insertAtom.run({
					id,
					type: "fact",
					title: id,
					summary: `s-${id}`,
					content: `c-${id}`,
					tags: JSON.stringify([`${id}token`]),
					importance: 0.5,
					strength: 0.5,
					access_count: 0,
					version: 1,
					is_latest: 1,
					parent_id: null,
					superseded_at: null,
					archived: 0,
					created_at: 1000,
					updated_at: 1000,
					last_access: null,
					content_fingerprint: fp,
					source_session: null,
				});
				insertVec.run(id, new Float32Array(1024));
			};
			seed("a1", "fp-1");
			seed("a2", "fp-2");

			// First init after seeding → backfills 2 atoms.
			await idx.init();
			const countAfterFirst = db.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as {
				c: number;
			};
			expect(countAfterFirst.c).toBe(2);

			// Second init → no change (memory_fts already exists, no re-create, no re-backfill).
			await idx.init();
			const countAfterSecond = db.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as {
				c: number;
			};
			expect(countAfterSecond.c).toBe(2);

			// And per-atom MATCH still finds exactly 1 row each — proving
			// no duplicates were inserted on the second init.
			expect(
				(
					db
						.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
						.all("a1token") as Array<{ rowid: number }>
				).length,
			).toBe(1);
			expect(
				(
					db
						.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
						.all("a2token") as Array<{ rowid: number }>
				).length,
			).toBe(1);
		});

		it("init creates empty memory_fts on fresh DB with no active atoms", async () => {
			// Edge case: DB with the base schema applied but zero atoms in
			// memory_index. init() must still create memory_fts (table exists,
			// zero rows).
			await idx.init();

			const db = idx.getRawDb();
			const exists = db.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'",
			).get();
			expect(exists).toBeDefined();

			const count = db.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as { c: number };
			expect(count.c).toBe(0);
		});

		it("init repairs broken memory_fts (NULL ids)", async () => {
			// Task 7.3 smoke test: the user's real ~/.pi/agent/memory/memory.db
			// has memory_fts with rows but ALL id columns are NULL — leftover
			// from an earlier parallel session that created the table in
			// contentless mode (content=''), which didn't populate the
			// UNINDEXED id column on INSERT. Such a table silently breaks
			// every bm25Search JOIN (`v.id IS NULL` never matches `i.id`).
			// init() must detect the broken state and rebuild memory_fts
			// from memory_index — same backfill SQL as the cold-start path.
			const db = idx.getRawDb();
			await idx.init();

			// Drop the auto-created memory_fts and re-create a "broken"
			// version. We use the same column shape as the production
			// schema (id UNINDEXED, title, summary, content, tags) but
			// INSERT 2 rows with explicit id=NULL. UNINDEXED columns in
			// FTS5 accept NULL (stored, not indexed); the resulting table
			// mirrors the user's failure mode at the row level: row exists,
			// id is NULL.
			db.exec("DROP TABLE memory_fts");
			db.exec(`
				CREATE VIRTUAL TABLE memory_fts USING fts5(
					id UNINDEXED,
					title,
					summary,
					content,
					tags,
					tokenize='unicode61 remove_diacritics 2'
				)
			`);
			db.prepare(
				"INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (NULL, ?, ?, ?, ?)",
			).run("broken1", "broken1", "broken1", "broken1");
			db.prepare(
				"INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (NULL, ?, ?, ?, ?)",
			).run("broken2", "broken2", "broken2", "broken2");

			// Pre-condition sanity: 2 NULL-id rows confirmed (broken state).
			// If this fails, the test premise is invalid — the broken
			// state must be visible to init()'s detection query.
			const brokenCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id IS NULL")
				.get() as { c: number };
			expect(brokenCount.c).toBe(2);

			// Seed memory_index with 2 active atoms that the repair
			// backfill can recover into the rebuilt memory_fts. The
			// tag-token uses pure alnum chars (no hyphens) so FTS5 MATCH
			// parses it cleanly — FTS5 treats `-` as a NOT operator.
			const insertAtom = db.prepare(`
				INSERT INTO memory_index (
					id, type, title, summary, content, tags, importance, strength,
					access_count, version, is_latest, parent_id, superseded_at, archived,
					created_at, updated_at, last_access, content_fingerprint, source_session
				) VALUES (
					@id, @type, @title, @summary, @content, @tags, @importance, @strength,
					@access_count, @version, @is_latest, @parent_id, @superseded_at, @archived,
					@created_at, @updated_at, @last_access, @content_fingerprint, @source_session
				)
			`);
			const insertVec = db.prepare(
				"INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)",
			);
			for (let i = 1; i <= 2; i++) {
				insertAtom.run({
					id: `repairomicron${i}`,
					type: "fact",
					title: `repairtitle${i}`,
					summary: `repairsummary${i}`,
					content: `repaircontent${i}`,
					tags: JSON.stringify([`repairtag${i}`]),
					importance: 0.5,
					strength: 0.5,
					access_count: 0,
					version: 1,
					is_latest: 1,
					parent_id: null,
					superseded_at: null,
					archived: 0,
					created_at: 1000 + i,
					updated_at: 1000 + i,
					last_access: null,
					content_fingerprint: `fp-repair-${i}`,
					source_session: null,
				});
				insertVec.run(`repairomicron${i}`, new Float32Array(1024));
			}

			// init() should detect the broken state and rebuild.
			await idx.init();

			// After init: 0 NULL-id rows (the broken rows are gone).
			const stillBroken = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id IS NULL")
				.get() as { c: number };
			expect(stillBroken.c).toBe(0);

			// Total row count matches the 2 active atoms (backfill worked).
			const countWithId = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id IS NOT NULL")
				.get() as { c: number };
			expect(countWithId.c).toBe(2);

			// Per-atom assertion: the rebuilt memory_fts has the right
			// ids (not just any 2 rows) — match each unique title token
			// against memory_fts and verify the id is the active atom.
			const hit1 = db
				.prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ?")
				.all("repairtitle1") as Array<{ id: string }>;
			expect(hit1.map((r) => r.id)).toEqual(["repairomicron1"]);
			const hit2 = db
				.prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ?")
				.all("repairtitle2") as Array<{ id: string }>;
			expect(hit2.map((r) => r.id)).toEqual(["repairomicron2"]);

			// End-to-end behaviour: bm25Search for a token from a seeded
			// atom now returns it. Before the repair this would silently
			// return [] because the JOIN key (v.id) was NULL.
			const bmHits = idx.bm25Search("repairtitle1", 10);
			expect(bmHits.map((r) => r.id)).toContain("repairomicron1");
		});

		it("init does not touch valid memory_fts (no false repair)", async () => {
			// Negative test: a healthy memory_fts (no NULL-id rows) must
			// not be dropped or rebuilt by init(). The defensive repair
			// should only fire when broken state is detected. If init()
			// incorrectly triggered a repair, the existing valid rows
			// would be replaced by a backfill from memory_index — the
			// "valid1" / "valid2" ids would be lost and a phantom
			// "wouldbeinserted" row would appear.
			const db = idx.getRawDb();
			await idx.init();

			// Drop the auto-created memory_fts and create a healthy one
			// with 2 valid rows. Captures the rowids up front so we can
			// prove the SAME rows survive init() — a DROP+CREATE would
			// reassign rowids and the assertion would fail.
			db.exec("DROP TABLE memory_fts");
			db.exec(`
				CREATE VIRTUAL TABLE memory_fts USING fts5(
					id UNINDEXED,
					title,
					summary,
					content,
					tags,
					tokenize='unicode61 remove_diacritics 2'
				)
			`);
			db.prepare(
				"INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)",
			).run("valid1", "validtitle1", "validsummary1", "validcontent1", "validtag1");
			db.prepare(
				"INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)",
			).run("valid2", "validtitle2", "validsummary2", "validcontent2", "validtag2");

			const before1 = db
				.prepare("SELECT rowid FROM memory_fts WHERE id = ?")
				.get("valid1") as { rowid: number };
			const before2 = db
				.prepare("SELECT rowid FROM memory_fts WHERE id = ?")
				.get("valid2") as { rowid: number };

			// Also insert an active atom into memory_index. If init()
			// wrongly triggered a repair, the backfill would insert this
			// atom into memory_fts — proving the false-positive path.
			const insertAtom = db.prepare(`
				INSERT INTO memory_index (
					id, type, title, summary, content, tags, importance, strength,
					access_count, version, is_latest, parent_id, superseded_at, archived,
					created_at, updated_at, last_access, content_fingerprint, source_session
				) VALUES (
					@id, @type, @title, @summary, @content, @tags, @importance, @strength,
					@access_count, @version, @is_latest, @parent_id, @superseded_at, @archived,
					@created_at, @updated_at, @last_access, @content_fingerprint, @source_session
				)
			`);
			const insertVec = db.prepare(
				"INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)",
			);
			insertAtom.run({
				id: "wouldbeinserted",
				type: "fact",
				title: "wouldbetitle",
				summary: "wouldbesummary",
				content: "wouldbecontent",
				tags: JSON.stringify(["wouldbetag"]),
				importance: 0.5,
				strength: 0.5,
				access_count: 0,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: 1000,
				updated_at: 1000,
				last_access: null,
				content_fingerprint: "fp-would",
				source_session: null,
			});
			insertVec.run("wouldbeinserted", new Float32Array(1024));

			// init() should be a no-op for the healthy memory_fts.
			await idx.init();

			// The original 2 valid rows must still exist with the SAME
			// rowids — a DROP+CREATE would reassign rowids, so this
			// catches any false repair.
			const after1 = db
				.prepare("SELECT rowid FROM memory_fts WHERE id = ?")
				.get("valid1") as { rowid: number };
			const after2 = db
				.prepare("SELECT rowid FROM memory_fts WHERE id = ?")
				.get("valid2") as { rowid: number };
			expect(after1.rowid).toBe(before1.rowid);
			expect(after2.rowid).toBe(before2.rowid);

			// The "wouldbeinserted" atom must NOT have been backfilled —
			// a false repair would have replaced the valid rows with a
			// backfill from memory_index, surfacing this id.
			const wouldbeCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get("wouldbeinserted") as { c: number };
			expect(wouldbeCount.c).toBe(0);

			// Total count is still 2 (no additions, no removals).
			const totalCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts")
				.get() as { c: number };
			expect(totalCount.c).toBe(2);

			// And of course, no NULL-id rows (the trigger condition
			// is absent, so the repair branch must not fire).
			const nullCount = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id IS NULL")
				.get() as { c: number };
			expect(nullCount.c).toBe(0);
		});
	});

	describe("bm25 search", () => {
		// Hybrid recall: bm25Search is the keyword half of RRF fusion (see
		// search.ts). Mirrors vectorSearch's filter handling (archived / type /
		// isLatestOnly) but ranks by FTS5 bm25() instead of sqlite-vec distance.
		// Per "召回对单 channel 降级鲁棒": bm25Search must never throw on user
		// input — special FTS5 chars (`"`, `(`, `)`, `*`, `:`, `[`, `]`) are
		// stripped from the query before it is bound as the MATCH parameter.
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

		const dummyEmbedding = (): number[] => new Array(1024).fill(0.1);

		// Seed an atom. insertAtom now writes memory_fts in the same
		// transaction (see storage.ts); we still mirror manually here so the
		// bm25Search tests can control the exact FTS5 text payload (the
		// production sync uses `atom.tags.join(' ')'` for tags, while the
		// bm25Search fixtures need verbatim tokens like `["amplicon"]` to
		// MATCH cleanly).
		const insertWithFts = async (
			atom: MemoryAtom,
			text: { title: string; summary: string; content: string; tags: string[] },
		): Promise<void> => {
			await index.insertAtom(atom, dummyEmbedding());
			index
				.getRawDb()
				.prepare(
					"INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)",
				)
				.run(atom.id, text.title, text.summary, text.content, JSON.stringify(text.tags));
		};

		it("bm25Search returns ranked hits for keyword query", async () => {
			// Three atoms with distinct keyword vocab. Query for "amplicon" —
			// only the amplicon atom should match, at rank 1, with a finite
			// (negative) BM25 score.
			const a1 = sampleAtom({ id: "amplicon-atom", content_fingerprint: "fp-amp" });
			const a2 = sampleAtom({ id: "rna-atom", content_fingerprint: "fp-rna" });
			const a3 = sampleAtom({ id: "lefse-atom", content_fingerprint: "fp-lefse" });

			await insertWithFts(a1, {
				title: "amplicon data",
				summary: "amplicon sequencing overview",
				content: "amplicon data analysis pipeline",
				tags: ["amplicon", "biomarker"],
			});
			await insertWithFts(a2, {
				title: "rna virus",
				summary: "rna virus detection",
				content: "rna virus sequencing",
				tags: ["rna", "virus"],
			});
			await insertWithFts(a3, {
				title: "lefse biomarker",
				summary: "lefse biomarker discovery",
				content: "lefse biomarker analysis",
				tags: ["lefse", "biomarker"],
			});

			const results = index.bm25Search("amplicon", 10);

			expect(results.length).toBeGreaterThan(0);
			expect(results[0]!.id).toBe("amplicon-atom");
			// FTS5 bm25() returns a negative number; lower (more negative) =
			// more relevant. We only assert it is a finite number here.
			expect(typeof results[0]!.bm25).toBe("number");
			expect(Number.isFinite(results[0]!.bm25)).toBe(true);
		});

		it("bm25Search escapes FTS5 special chars in query", async () => {
			// Atom contains Chinese tokens `没有` and `结果` plus `lefse`.
			// We send a query that mixes these literal tokens with FTS5
			// syntax chars (`"`, `(`, `*`, `:`). Without escape, SQLite would
			// raise "fts5: syntax error"; with escape, the chars are stripped
			// to spaces and the literal tokens survive. All three post-escape
			// tokens (`lefse`, `没有`, `结果`) must be present in the atom
			// because FTS5 default MATCH treats whitespace-separated tokens
			// as implicit AND.
			const atom = sampleAtom({
				id: "lefse-cn",
				type: "fact",
				content_fingerprint: "fp-lefse-cn",
			});

			await insertWithFts(atom, {
				title: "lefse 没有 结果",
				summary: "lefse 没有 结果 summary",
				content: "lefse 没有 结果 content with details",
				tags: ["lefse"],
			});

			const query = 'lefse "没有" 结果';

			// Must NOT throw — escape is the safety net for arbitrary user input.
			expect(() => index.bm25Search(query, 10)).not.toThrow();

			const results = index.bm25Search(query, 10);

			// Even after escape, the literal tokens `lefse`, `没有`, `结果`
			// still match the seeded atom — proving the escape is content-
			// preserving, not just syntactic sugar.
			expect(results.length).toBeGreaterThan(0);
			expect(results[0]!.id).toBe("lefse-cn");
		});
	});

	describe("insertAtom sync to memory_fts", () => {
		// insertAtom is the only write path that produces new active atoms
		// (supersede transactions route through updateAtom + the
		// markSupersededTx flow). It must keep memory_fts in lock-step with
		// memory_index inside a single db.transaction so a failed FTS5 write
		// rolls back the index/vector writes too. See principle
		// "FTS5 行同步在 storage 层原子化,与 memory_index 同事务".
		let idx: MemoryIndex;

		beforeEach(async () => {
			idx = new MemoryIndex(":memory:");
			await idx.init();
		});

		afterEach(() => {
			idx.close();
		});

		const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
			id: randomUUID(),
			type: "rule",
			title: "title1alpha",
			content: "content1alpha",
			summary: "summary1alpha",
			tags: ["tag1alpha", "tag2alpha"],
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

		it("insertAtom writes memory_fts row", async () => {
			// Scenario: insertAtom writes a matching memory_fts row. Each of
			// the four indexed fields (title / summary / content / tags) gets
			// a unique alnum token so MATCH returns exactly 1 row per field —
			// proving each landed in the FTS5 index, not just that the count
			// happens to be 1.
			const atom = sampleAtom();
			await idx.insertAtom(atom, dummyEmbedding());

			const db = idx.getRawDb();

			const count = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get(atom.id) as { c: number };
			expect(count.c).toBe(1);

			const match = (term: string): number =>
				(
					db
						.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
						.all(term) as Array<{ rowid: number }>
				).length;

			expect(match("title1alpha")).toBe(1);
			expect(match("summary1alpha")).toBe(1);
			expect(match("content1alpha")).toBe(1);
			// tags.join(" ") → "tag1alpha tag2alpha" — both tokens indexed.
			expect(match("tag1alpha")).toBe(1);
			expect(match("tag2alpha")).toBe(1);
		});

		it("insertAtom writes memory_fts atomically with memory_index and memory_vectors", async () => {
			// Inject a failure on the memory_fts INSERT to verify that all
			// three writes inside the transaction roll back together. The
			// atomicity contract: a partial write to memory_fts MUST NOT
			// leave dangling memory_index / memory_vectors rows.
			//
			// We shadow `prepare` on the live better-sqlite3 handle for the
			// duration of this test. The handler is the same object that
			// `insertAtom` calls `this.db.prepare` on, so the shadow is
			// observed inside the transaction body. Restore in `finally` so
			// afterEach / idx.close() still work.
			const db = idx.getRawDb() as unknown as {
				prepare: (sql: string) => unknown;
			};
			const origPrepare = db.prepare.bind(db);
			db.prepare = (sql: string): unknown => {
				if (sql.includes("INSERT INTO memory_fts")) {
					throw new Error("FTS5 inject failure");
				}
				return origPrepare(sql);
			};

			try {
				const atom = sampleAtom();
				await expect(idx.insertAtom(atom, dummyEmbedding())).rejects.toThrow();

				// All three tables must have zero rows for this atom id —
				// the transaction rolled back as a unit.
				const dbAfter = idx.getRawDb();
				expect(
					dbAfter
						.prepare("SELECT COUNT(*) AS c FROM memory_index WHERE id = ?")
						.get(atom.id),
				).toEqual({ c: 0 });
				expect(
					dbAfter
						.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE id = ?")
						.get(atom.id),
				).toEqual({ c: 0 });
				expect(
					dbAfter
						.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
						.get(atom.id),
				).toEqual({ c: 0 });
			} finally {
				// Restore so afterEach / idx.close() work normally.
				(db as { prepare: typeof origPrepare }).prepare = origPrepare;
			}
		});

		it("insertAtom handles empty tags array in memory_fts (empty string is fine for FTS5)", async () => {
			// Edge case: `atom.tags` is `[]` → `tags.join(" ")` → "" (empty
			// string). FTS5 accepts an empty string for a TEXT column and
			// indexes the row with no tokens in the tags column.
			const atom = sampleAtom({ tags: [] });
			await idx.insertAtom(atom, dummyEmbedding());

			const db = idx.getRawDb();
			const count = db
				.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
				.get(atom.id) as { c: number };
			expect(count.c).toBe(1);

			// The other three fields are still indexed (only tags is empty).
			const match = (term: string): number =>
				(
					db
						.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
						.all(term) as Array<{ rowid: number }>
				).length;

			expect(match("title1alpha")).toBe(1);
			expect(match("summary1alpha")).toBe(1);
			expect(match("content1alpha")).toBe(1);
		});
	});
});