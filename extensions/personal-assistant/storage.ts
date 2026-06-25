// MemoryIndex — better-sqlite3 + sqlite-vec wrapper for the v2 memory model.
//
// Phase 2.2 surface: constructor + init() + close(). Future phases add
// insert/update/get (2.3), vector search (2.4), supersede transactions (2.5),
// and updateAccess/updateStrength/archive (2.6).
//
// Design constraints honoured here (see docs/sdd/changes/memory-v2-refactor):
//   - Decision 1: pure vector recall via sqlite-vec KNN (no FTS5).
//   - Decision 5: UNIQUE partial index on content_fingerprint for active rows
//     prevents concurrent duplicate writes of the same atom content.
//   - WAL mode for concurrent readers; foreign_keys ON for future FKs.
//   - vec0 dimension = 1024 (bge-m3 embeddings).
//   - Tags stored as a JSON string in a single TEXT column.
//   - FTS5 mirror `memory_fts` (memory-v2-refactor; FTS5 schema and storage
//     sync requirement): created and one-shot backfilled in init() from
//     active atoms only (`archived = 0 AND is_latest = 1`). The init-time
//     backfill is the only place we read FTS5's source — per-write sync
//     (insertAtom / updateAtom / markArchived / markSupersededTx) is added
//     in a later phase and will keep memory_fts in lock-step with
//     memory_index transactionally.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryAtom, MemoryAtomRow, MemoryAtomType } from "./types.ts";
import { atomToRow, rowToAtom } from "./types.ts";

// better-sqlite3 is CommonJS without shipped .d.ts; sqlite-vec ships its own
// .d.ts but we load both via createRequire for symmetry with deps.test.ts and
// to avoid a hard dependency on @types/better-sqlite3. The `require` namespace
// returned by createRequire is typed `any` by @types/node, so the runtime
// value is captured into a typed alias right below.
const requireCJS = createRequire(import.meta.url);

// Minimal interface covering the small slice of better-sqlite3 we actually
// use in this phase. Future phases will extend this (transaction, prepare
// result iteration, etc.) rather than reaching for the full @types package.
interface BetterSqlite3Database {
	loadExtension(file: string, entry?: string): void;
	pragma(source: string): unknown;
	exec(source: string): unknown;
	close(): void;
	prepare(source: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
	};
	transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
}

interface SqliteVecModule {
	getLoadablePath(): string;
}

const BetterSqlite3 = requireCJS("better-sqlite3") as new (
	path: string,
) => BetterSqlite3Database;

const sqliteVec = requireCJS("sqlite-vec") as SqliteVecModule;

/**
 * Strip FTS5 query syntax characters from a user-supplied search string before
 * binding it as the `MATCH` parameter of a `memory_fts MATCH ?` query.
 *
 * FTS5 reserves `"`, `(`, `)`, `*`, `:`, `[`, `]`, `,` for phrase / NEAR /
 * column queries and a stray unescaped character raises "fts5: syntax error".
 * The comma in particular is the NEAR separator (`a, b` = "a NEAR b") and is
 * the most surprising of the set — natural-language user queries like
 * `这个先不管,这个项目路径下lefse没有结果` contain ASCII commas and would
 * otherwise throw. Stripping to space (rather than doubling `"`) is the
 * simplest and safest transformation: the literal token content is preserved,
 * special-char noise is gone, and an all-special input collapses to an empty
 * (no-match) query rather than throwing. The result is trimmed so a query
 * consisting entirely of special characters becomes the empty string;
 * bm25Search short-circuits on empty rather than running `MATCH ''` (which
 * would also error).
 *
 * Module-level (not a class method) because it is pure — no DB access — and
 * has no business depending on `this`.
 */
export function escapeFtsQuery(s: string): string {
	// Whitelist approach: keep ONLY ASCII letters, digits, underscore,
	// and whitespace. Strip everything else (FTS5 syntax chars, file-path
	// separators, CJK, fullwidth punctuation). The corpus's unicode61
	// tokenizer with `remove_diacritics 2` indexes the same character
	// class (alphanumeric + underscore ASCII + whitespace as separator),
	// so this is the exact symmetric form for MATCH. CJK is stripped
	// because unicode61 groups consecutive CJK into one token, making
	// per-character MATCH fail; the dense channel handles semantic
	// Chinese search. Enumerating the bad chars is fragile — `;`, `!`,
	// `?`, `&`, `|`, `~`, `@`, `#`, `$`, `%`, `=`, `<`, `>`, `'`, `\`,
	// `{`, `}`, `^` (when wrapped) all individually raise "fts5:
	// syntax error" depending on context, and adding them one at a
	// time as user queries surface them is an endless whack-a-mole.
	// Inverting the regex to "keep only the safe class" is a closed
	// enumeration of the corpus's unicode61 token alphabet.
	return s.replace(/[^a-zA-Z0-9_\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Wraps a single better-sqlite3 connection that has the sqlite-vec extension
 * loaded and the v2 memory schema applied. Designed to be constructed once
 * per process and shared across handlers.
 */
export class MemoryIndex {
	private db: BetterSqlite3Database;
	private readonly dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
		// better-sqlite3 refuses to create the parent directory of a
		// file-backed DB — calling new Database() against a path whose
		// `dirname()` does not exist throws SQLITE_CANTOPEN. This breaks
		// first-run / recovery flows: if the user clears ~/.pi/agent/memory
		// (or installs onto a fresh machine), the very next session_before_
		// compact / session_start / before_agent_start call hits this error
		// and the extraction silently no-ops (the runtime's emit() catch
		// swallows it so the surrounding flow still completes). Self-heal
		// the parent dir here so MemoryIndex is safe to construct in any
		// of those contexts. In-memory DBs (dbPath === ":memory:") have
		// no parent dir to create.
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new BetterSqlite3(dbPath);
		this.db.loadExtension(sqliteVec.getLoadablePath());
		// WAL requires a file-backed database: an in-memory db has no journal
		// file to write to and the PRAGMA errors out. Tests use ":memory:"
		// for speed, so we skip WAL silently in that case.
		if (dbPath !== ":memory:") {
			this.db.pragma("journal_mode = WAL");
		}
		this.db.pragma("foreign_keys = ON");
	}

	async init(): Promise<void> {
		// Async signature reserved for future phases that may need to do
		// filesystem checks or async migrations; the body stays synchronous
		// for Phase 2.2.
		this.db.exec(SCHEMA_SQL);

		// Column-level migration for `embed_text_version` (added when the
		// embeddable text dropped `content`). New DBs get the column via
		// SCHEMA_SQL with DEFAULT 0. Existing DBs that pre-date the column
		// need an ALTER TABLE — `CREATE TABLE IF NOT EXISTS` is a no-op when
		// the table already exists, so the column would otherwise be
		// missing on upgraded DBs and every query referencing it would fail.
		// Idempotent: re-running this on a DB that already has the column
		// is a no-op.
		const hasEmbedTextVersion = (
			this.db
				.prepare("PRAGMA table_info(memory_index)")
				.all() as { name: string }[]
		).some((c) => c.name === "embed_text_version");
		if (!hasEmbedTextVersion) {
			this.db.exec(
				"ALTER TABLE memory_index ADD COLUMN embed_text_version INTEGER NOT NULL DEFAULT 0",
			);
		}

		// FTS5 mirror — build if missing, repair if broken.
		//
		// On a fresh DB, memory_fts does not yet exist: we create it via
		// MEMORY_FTS_SCHEMA and one-shot backfill from every active atom
		// (archived = 0 AND is_latest = 1) so the FTS5 index is in
		// lock-step with memory_index on first open.
		//
		// On subsequent re-opens, memory_fts already exists — we deliberately
		// do NOT re-create it nor re-backfill in the healthy case. That
		// keeps init() strictly idempotent (same DB opened twice MUST NOT
		// produce duplicate rows) and avoids an unnecessary full-table scan
		// on every startup. Per-write sync is the responsibility of
		// insertAtom / updateAtom / markArchived / markSupersededTx in
		// later phases; the init-time backfill only handles the "upgrade"
		// case where a DB existed before memory_fts was introduced.
		//
		// Defensive repair: an earlier session may have left behind a
		// memory_fts that has rows but ALL `id` columns are NULL — e.g.
		// the table was created in contentless mode (content='') which
		// does not populate the UNINDEXED id column on INSERT. Such a
		// table silently breaks every bm25Search JOIN (`v.id IS NULL`
		// never matches `i.id`). Detect by counting NULL-id rows and
		// rebuild — same CREATE + backfill as the cold-start path,
		// with an extra DROP first. The repair is:
		//   1. Idempotent — only fires when broken state is detected.
		//   2. Atomic — DROP + CREATE + backfill in a single transaction;
		//      a failed backfill rolls back the empty FTS5 table rather
		//      than leaving a half-built schema.
		//   3. Safe for new DBs — no rows → no NULL-id rows → no repair.
		//   4. Safe for correctly-built memory_fts — no NULL-id rows → no
		//      repair, table is left untouched.
		// The trade-off: a broken memory_fts (silent BM25 failure) is
		// worse than a brief startup-time rebuild — principle
		// "宁可漏召不可误召" favours a one-shot repair over persisting
		// the broken state.
		const ftsExists = this.db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'",
			)
			.get();
		// Rebuild when:
		//   1. memory_fts is missing (cold-start / fresh upgrade), or
		//   2. it has NULL-id rows (broken contentless-mode artifact), or
		//   3. row count doesn't match active atoms (missing rows from
		//      an earlier incomplete backfill — e.g. a prior init ran
		//      before FTS5 support was fully rolled out).
		// Must check active count FIRST so the `||` short-circuit works
		// when the table is missing (SELECT on memory_fts would error).
		const activeCount = (
			this.db
				.prepare(
					"SELECT COUNT(*) AS c FROM memory_index WHERE archived = 0 AND is_latest = 1",
				)
				.get() as { c: number }
		).c;
		const ftsNullCount = ftsExists
			? (
					this.db
						.prepare(`SELECT COUNT(*) AS c FROM memory_fts WHERE id IS NULL`)
						.get() as { c: number }
				).c
			: 0;
		const ftsCount = ftsExists
			? (
					this.db
						.prepare(`SELECT COUNT(*) AS c FROM memory_fts`)
						.get() as { c: number }
				).c
			: 0;
		const needsRebuild = !ftsExists || ftsNullCount > 0 || activeCount > ftsCount;
		if (!needsRebuild) return;

		this.db.transaction(() => {
			if (ftsExists) {
				this.db.prepare(`DROP TABLE memory_fts`).run();
			}
			this.db.exec(MEMORY_FTS_SCHEMA);
			this.db
				.prepare(
					`INSERT INTO memory_fts(id, title, summary, content, tags)
						 SELECT id, title, summary, content, COALESCE(tags, '')
						 FROM memory_index
						 WHERE archived = 0 AND is_latest = 1`,
				)
				.run();
		})();
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Returns the underlying better-sqlite3 handle. Exposed strictly for
	 * schema/structure assertions in tests; application code must not use
	 * this — all reads and writes go through typed methods (insertAtom,
	 * getAtom, …) added in later phases.
	 *
	 * @internal
	 */
	getRawDb(): BetterSqlite3Database {
		return this.db;
	}

	// -------------------------------------------------------------------------
	// Phase 2.3: atom CRUD + fingerprint dedup
	// -------------------------------------------------------------------------

	/**
	 * Insert a new atom row + its vector in a single transaction. The caller
	 * computes the embedding — storage never touches the embedder.
	 *
	 * The active-fingerprint UNIQUE partial index will reject a second
	 * active row with the same content_fingerprint; that constraint is what
	 * gives us dedup at write time (R3 / S15).
	 */
	async insertAtom(atom: MemoryAtom, embedding: number[]): Promise<void> {
		const row = atomToRow(atom);
		this.db.transaction(() => {
			this.db
				.prepare(
					`
				INSERT INTO memory_index (
					id, type, title, summary, content, tags, importance, strength,
					access_count, version, is_latest, parent_id, superseded_at, archived,
					created_at, updated_at, last_access, content_fingerprint, source_session
				) VALUES (
					@id, @type, @title, @summary, @content, @tags, @importance, @strength,
					@access_count, @version, @is_latest, @parent_id, @superseded_at, @archived,
					@created_at, @updated_at, @last_access, @content_fingerprint, @source_session
				)
			`,
				)
				.run(row);
			this.db
				.prepare(`INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)`)
				.run(atom.id, new Float32Array(embedding));
			// FTS5 mirror must stay in lock-step with memory_index. Wrapped in
			// the same db.transaction so a failure here rolls back the
			// memory_index + memory_vectors writes above (atomicity contract
			// for principle "FTS5 行同步在 storage 层原子化"). tags is
			// space-joined so the unicode61 tokenizer indexes each tag as a
			// distinct token; an empty array → "" which FTS5 accepts fine.
			this.db
				.prepare(
					`INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)`,
				)
				.run(atom.id, atom.title, atom.summary, atom.content, atom.tags.join(" "));
		})();
	}

	/**
	 * Update the mutable fields of an existing atom. Increments `version` on
	 * the row (the value passed in `atom.version` is ignored — the SQL does
	 * `version = version + 1`). If `embedding` is provided, the vector row
	 * is also updated in the same transaction.
	 */
	async updateAtom(atom: MemoryAtom, embedding?: number[]): Promise<void> {
		const row = atomToRow(atom);
		this.db.transaction(() => {
			this.db
				.prepare(
					`
				UPDATE memory_index SET
					title = @title, summary = @summary, content = @content, tags = @tags,
					importance = @importance, version = version + 1, updated_at = @updated_at,
					content_fingerprint = @content_fingerprint
				WHERE id = @id
			`,
				)
				.run(row);
			if (embedding) {
				this.db
					.prepare(`UPDATE memory_vectors SET embedding = ? WHERE id = ?`)
					.run(new Float32Array(embedding), atom.id);
			}
		})();
	}

	/**
	 * Fetch an atom by id regardless of state — active, archived, or
	 * superseded. Returns null when no row exists.
	 */
	getAtom(id: string): MemoryAtom | null {
		const row = this.db
			.prepare(`SELECT * FROM memory_index WHERE id = ?`)
			.get(id) as MemoryAtomRow | undefined;
		return row ? rowToAtom(row) : null;
	}

	/**
	 * Look up the active + latest atom matching a content fingerprint. Used
	 * at write time to detect duplicate content and to short-circuit the
	 * extraction pipeline (S15 / R12).
	 */
	getActiveAtomByFingerprint(fingerprint: string): MemoryAtom | null {
		const row = this.db
			.prepare(
				`
			SELECT * FROM memory_index
			WHERE content_fingerprint = ? AND is_latest = 1 AND archived = 0
		`,
			)
			.get(fingerprint) as MemoryAtomRow | undefined;
		return row ? rowToAtom(row) : null;
	}

	/**
	 * All active atoms, newest first. Optionally filtered by type. Excludes
	 * archived and superseded rows (S2 / S3 / S4).
	 */
	getActiveAtoms(type?: MemoryAtomType): MemoryAtom[] {
		const sql = type
			? `SELECT * FROM memory_index WHERE is_latest = 1 AND archived = 0 AND type = ? ORDER BY created_at DESC`
			: `SELECT * FROM memory_index WHERE is_latest = 1 AND archived = 0 ORDER BY created_at DESC`;
		const stmt = this.db.prepare(sql);
		const rows = (
			type ? (stmt.all(type) as MemoryAtomRow[]) : (stmt.all() as MemoryAtomRow[])
		);
		return rows.map(rowToAtom);
	}

	/**
	 * Convenience wrapper: active atoms of a single type. Equivalent to
	 * `getActiveAtoms(type)`.
	 */
	getActiveAtomsByType(type: MemoryAtomType): MemoryAtom[] {
		return this.getActiveAtoms(type);
	}

	/**
	 * List atoms with flexible archive filtering. Default (no filter) returns
	 * only active + latest atoms. Pass `archived: true` for only archived rows,
	 * `archived: "all"` for both active and archived.
	 */
	listAtoms(filter?: { archived?: boolean | "all"; type?: MemoryAtomType }): MemoryAtom[] {
		const where: string[] = [];
		const params: unknown[] = [];
		if (filter?.type) {
			where.push("type = ?");
			params.push(filter.type);
		}
		if (filter?.archived === true) {
			where.push("archived = 1");
		} else if (filter?.archived !== "all") {
			where.push("archived = 0");
		}
		where.push("is_latest = 1");
		const sql = `SELECT * FROM memory_index${where.length > 0 ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
		const rows = this.db.prepare(sql).all(...params) as MemoryAtomRow[];
		return rows.map(rowToAtom);
	}

	// -------------------------------------------------------------------------
	// Phase 2.4: vector search
	// -------------------------------------------------------------------------

	/**
	 * Build the WHERE clause + prefix params for the standard
	 * "active atoms only" filter shared by `vectorSearch` and
	 * `bm25Search`. `archived: true` overrides the active-only
	 * filter (includes both active and archived rows). The caller
	 * appends its own MATCH / LIMIT bindings after `prefixParams`.
	 */
	private buildActiveFilter(filter?: {
		type?: MemoryAtomType;
		archived?: boolean;
		isLatestOnly?: boolean;
	}): { whereSql: string; prefixParams: (string | number)[] } {
		const whereClauses: string[] = ["archived = 0"];
		const prefixParams: (string | number)[] = [];
		if (filter?.type) {
			whereClauses.push("type = ?");
			prefixParams.push(filter.type);
		}
		if (filter?.isLatestOnly !== false) whereClauses.push("is_latest = 1");
		if (filter?.archived === true) {
			// explicit override — include archived + superseded too
			// (preserve the `WHERE <something> AND` prefix; empty
			// `whereClauses` would produce `WHERE  AND v.embedding MATCH ?`,
			// which is a SQL syntax error)
			return { whereSql: "1=1", prefixParams };
		}
		return { whereSql: whereClauses.join(" AND "), prefixParams };
	}

	/**
	 * K-nearest-neighbour query against the sqlite-vec `memory_vectors`
	 * virtual table, joined back to `memory_index` so the standard active
	 * filters (archived / superseded / type) can be applied. Default
	 * behaviour is to return only the active + latest atoms; the caller
	 * can opt into other rows with the `filter` argument.
	 *
	 * The KNN side uses sqlite-vec's native `MATCH … AND k = N` syntax
	 * with a `Float32Array` binding (R20). The `k` parameter both bounds
	 * sqlite-vec's internal candidate set and the number of returned
	 * rows; we rely on the post-JOIN filter to drop the rest.
	 */
	vectorSearch(
		embedding: number[],
		k: number,
		filter?: { type?: MemoryAtomType; archived?: boolean; isLatestOnly?: boolean },
	): Array<{ id: string; distance: number }> {
		const { whereSql, prefixParams } = this.buildActiveFilter(filter);
		const sql = `
			SELECT v.id, v.distance
			FROM memory_vectors v
			INNER JOIN memory_index i ON v.id = i.id
			WHERE ${whereSql}
			AND v.embedding MATCH ?
			AND k = ?
			ORDER BY v.distance
		`;
		const params: (string | number | Float32Array)[] = [
			...prefixParams,
			new Float32Array(embedding),
			k,
		];

		type Row = { id: string; distance: number };
		const rows = this.db.prepare(sql).all(...params) as Row[];
		return rows;
	}

	/**
	 * BM25 keyword ranking against the FTS5 mirror `memory_fts`, joined back to
	 * `memory_index` so the standard active filters (archived / superseded /
	 * type) can be applied identically to `vectorSearch`. The default
	 * behaviour is to return only the active + latest atoms; the caller can
	 * opt into other rows with the `filter` argument.
	 *
	 * FTS5's `bm25(memory_fts)` ranking function returns NEGATIVE values
	 * where smaller (more negative) = more relevant; we `ORDER BY bm25 ASC`
	 * directly so the most-relevant hit comes first. Do not normalise to a
	 * positive score here — RRF fusion (search.ts) operates on ranks, not on
	 * raw scores, and converting the sign would couple the two layers for no
	 * gain.
	 *
	 * The user query is run through `escapeFtsQuery` before binding as the
	 * MATCH parameter so that FTS5 syntax characters (`"`, `(`, `)`, `*`,
	 * `:`, `[`, `]`, `,`) cannot raise an SQL parse error. The comma is
	 * the FTS5 NEAR separator and is the most surprising of the set — user
	 * queries like `这个先不管,这个项目路径下lefse没有结果` contain ASCII
	 * commas and would otherwise throw "fts5: syntax error near ','". If
	 * the escape collapses the query to the empty string, we short-circuit
	 * with `[]` rather than running `MATCH ''` — both because the empty
	 * MATCH itself errors and because no atoms could possibly match anyway.
	 */
	bm25Search(
		query: string,
		k: number,
		filter?: { type?: MemoryAtomType; archived?: boolean; isLatestOnly?: boolean },
	): Array<{ id: string; bm25: number }> {
		const escaped = escapeFtsQuery(query);
		if (escaped === "") {
			// Defensive short-circuit: an all-special query like `"*("` would
			// collapse to empty after escape. Returning [] is the same answer
			// MATCH would give on an empty string, without the parse error.
			return [];
		}

		const { whereSql, prefixParams } = this.buildActiveFilter(filter);
		const sql = `
			SELECT v.id, bm25(memory_fts) AS bm25
			FROM memory_fts v
			INNER JOIN memory_index i ON v.id = i.id
			WHERE ${whereSql}
			AND memory_fts MATCH ?
			ORDER BY bm25
			LIMIT ?
		`;
		const params: (string | number)[] = [...prefixParams, escaped, k];

		type Row = { id: string; bm25: number };
		const rows = this.db.prepare(sql).all(...params) as Row[];
		return rows;
	}

	/**
	 * Top-1 lookup gated by a cosine-similarity threshold. Returns the
	 * hydrated atom + the cosine (derived from the L2 distance returned
	 * by sqlite-vec as `1 - distance²/2`, valid only when both vectors
	 * are L2-normalised) when the best match clears the threshold,
	 * otherwise null (R21).
	 */
	findMostSimilarEmbedding(
		embedding: number[],
		threshold: number,
		filter?: { type?: MemoryAtomType },
	): { atom: MemoryAtom; cosine: number } | null {
		// Pull top-5 candidates (not just top-1) so threshold check has a fair
		// chance even if the closest atom doesn't pass but #2-#5 might.
		const results = this.vectorSearch(embedding, 5, { ...filter });
		if (results.length === 0) return null;
		for (const r of results) {
			// Correct L2 → cosine: cosine = 1 - distance²/2 (only valid for
			// L2-normalized vectors, which bge-m3 outputs are).
			const cosine = 1 - (r.distance * r.distance) / 2;
			if (cosine >= threshold) {
				const atom = this.getAtom(r.id);
				if (atom) return { atom, cosine };
			}
		}
		return null;
	}

	/**
	 * Pure cosine similarity helper. Exposed for callers (and tests) that
	 * want to score two `number[]` vectors without going through sqlite.
	 * Throws when dimensions disagree — callers must normalise length
	 * first or accept a length-mismatch error as a programming bug.
	 */
	cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) throw new Error("dimension mismatch");
		let dot = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i]! * b[i]!;
			normA += a[i]! * a[i]!;
			normB += b[i]! * b[i]!;
		}
		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	// -------------------------------------------------------------------------
	// Phase 2.5: supersede transaction + audit log
	// -------------------------------------------------------------------------

	/**
	 * Atomic transaction that marks `oldId` as superseded and inserts `newAtom`
	 * as its successor, transferring continuity signals (access_count, strength,
	 * created_at) from the old row to the new one (R22 / R23 / S9).
	 *
	 * `newAtom.importance` is set to `max(old.importance, new.importance)` so a
	 * supersede never downgrades the priority of an existing well-ranked atom.
	 * The new atom always starts at `version = 1` (R23) regardless of the
	 * transferred signals.
	 *
	 * Both rows get audit-log entries in the same transaction: the old row
	 * gets `superseded` with the transferred signals, the new row gets
	 * `created_from_supersede` with the old id (R24 / S11).
	 *
	 * Throws if `oldId` is not found. If the INSERT of the new atom fails
	 * (e.g. UNIQUE fingerprint collision on the active-fingerprint partial
	 * index), the entire transaction — including the UPDATE marking the old
	 * atom superseded — is rolled back atomically (S10).
	 */
	markSupersededTx(
		oldId: string,
		newAtom: MemoryAtom,
		newEmbedding: number[],
	): { oldAtom: MemoryAtom; newAtom: MemoryAtom } {
		const old = this.getAtom(oldId);
		if (!old) throw new Error(`atom ${oldId} not found`);

		// Transfer continuity signals from old to new. The new atom's own
		// id, type, title, summary, content, tags, content_fingerprint, and
		// source_session are preserved from the caller-supplied newAtom.
		const transferredAtom: MemoryAtom = {
			...newAtom,
			parent_id: old.id,
			created_at: old.created_at, // preserve creation time
			access_count: old.access_count, // transfer access count
			strength: old.strength, // transfer strength
			version: 1, // new atom starts at v1
			importance: Math.max(newAtom.importance, old.importance),
		};

		this.db.transaction(() => {
			// Mark old as superseded. `Date.now()` is captured inside the
			// transaction so a failed rollback leaves no partial timestamp.
			this.db
				.prepare(
					`
				UPDATE memory_index SET
					is_latest = 0,
					superseded_at = ?
				WHERE id = ?
			`,
				)
				.run(Date.now(), oldId);

			// Insert the new atom row + its vector in the same transaction.
			// We inline the INSERT instead of calling `this.insertAtom`
			// because `insertAtom` is async: a sync throw inside its
			// inner transaction would be caught by the async wrapper and
			// surface as an unhandled Promise rejection AFTER the outer
			// transaction has already committed — defeating atomicity.
			// Inlining keeps any UNIQUE-constraint error on the active
			// fingerprint visible to `db.transaction`, which then rolls
			// back the entire supersede atomically (S10).
			const row = atomToRow(transferredAtom);
			this.db
				.prepare(
					`
				INSERT INTO memory_index (
					id, type, title, summary, content, tags, importance, strength,
					access_count, version, is_latest, parent_id, superseded_at, archived,
					created_at, updated_at, last_access, content_fingerprint, source_session
				) VALUES (
					@id, @type, @title, @summary, @content, @tags, @importance, @strength,
					@access_count, @version, @is_latest, @parent_id, @superseded_at, @archived,
					@created_at, @updated_at, @last_access, @content_fingerprint, @source_session
				)
			`,
				)
				.run(row);
			this.db
				.prepare(`INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)`)
				.run(transferredAtom.id, new Float32Array(newEmbedding));

			// FTS5 mirror must follow the supersede: drop the old atom's row so
			// it cannot match BM25, then insert the new atom's row (using the
			// transferred fields, not the raw newAtom — same rationale as the
			// memory_index INSERT above). Inside the same transaction so a
			// failed FTS5 write rolls back the supersede atomically.
			this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(oldId);
			this.db
				.prepare(
					`INSERT INTO memory_fts(id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)`,
				)
				.run(
					transferredAtom.id,
					transferredAtom.title,
					transferredAtom.summary,
					transferredAtom.content,
					transferredAtom.tags.join(" "),
				);

			// Audit: both atoms get an entry describing the supersede link.
			this.insertAudit(oldId, "superseded", {
				newId: transferredAtom.id,
				transferredSignals: {
					access_count: old.access_count,
					strength: old.strength,
					created_at: old.created_at,
				},
			});
			this.insertAudit(transferredAtom.id, "created_from_supersede", {
				oldId,
			});
		})();

		return { oldAtom: old, newAtom: transferredAtom };
	}

	/**
	 * Append a row to the `memory_audit` log. The created_at column is filled
	 * server-side from `unixepoch() * 1000` by the schema default, but we
	 * also pass an explicit `Date.now()` so the value matches what callers
	 * see elsewhere in the storage layer.
	 *
	 * `details` is JSON-encoded; pass `null`/omit to store an empty audit
	 * entry. Returns the new row id as a number (better-sqlite3 returns
	 * bigint for INTEGER PRIMARY KEY AUTOINCREMENT; we coerce to number for
	 * ergonomic JS usage — ids stay well within Number.MAX_SAFE_INTEGER
	 * for any realistic audit volume).
	 */
	insertAudit(atomId: string, action: string, details?: Record<string, unknown> | null): number {
		const stmt = this.db.prepare(`
			INSERT INTO memory_audit (atom_id, action, details, created_at)
			VALUES (?, ?, ?, ?)
		`);
		const result = stmt.run(atomId, action, details ? JSON.stringify(details) : null, Date.now());
		return Number(result.lastInsertRowid);
	}

	/**
	 * Read the most recent audit rows for a given atom, newest first. The
	 * `details` column is JSON-decoded back into the original object
	 * (null when the row was written without details). `limit` defaults to
	 * 50 to keep the result list bounded; pass a higher value for
	 * long-history inspection.
	 */
	getAudit(
		atomId: string,
		limit = 50,
	): Array<{ id: number; action: string; details: unknown; created_at: number }> {
		const rows = this.db
			.prepare(
				`
			SELECT id, action, details, created_at FROM memory_audit
			WHERE atom_id = ?
			ORDER BY created_at DESC LIMIT ?
		`,
			)
			.all(atomId, limit) as Array<{
			id: number | bigint;
			action: string;
			details: string | null;
			created_at: number;
		}>;
		return rows.map((r) => ({
			id: Number(r.id),
			action: r.action,
			details: r.details ? JSON.parse(r.details) : null,
			created_at: r.created_at,
		}));
	}

	// -------------------------------------------------------------------------
	// Phase 2.6: access tracking, strength decay, archive, vector GC
	// -------------------------------------------------------------------------

	/**
	 * Bump `access_count` by 1 and stamp `last_access` with the current
	 * time. Called on every successful recall (S12 / R25).
	 *
	 * No-op when the id does not exist — `UPDATE` against a missing row
	 * simply affects zero rows, which is the intended behaviour for
	 * idempotent recall paths.
	 */
	updateAccess(id: string): void {
		this.db
			.prepare(
				`
			UPDATE memory_index SET
				access_count = access_count + 1,
				last_access = ?
			WHERE id = ?
		`,
			)
			.run(Date.now(), id);
	}

	/**
	 * Set `strength` to a new value, typically the decay-modulated result
	 * computed by a separate decay function (this layer never computes
	 * decay itself — that lives in the memory module per the architecture
	 * split).
	 */
	updateStrength(id: string, strength: number): void {
		this.db.prepare(`UPDATE memory_index SET strength = ? WHERE id = ?`).run(strength, id);
	}

	/**
	 * Mark an atom as archived in a single transaction with an audit row
	 * (S13 / R26). The transaction makes the state change and the audit
	 * record atomic: a process crash between the UPDATE and the INSERT
	 * cannot leave the audit log out of sync with the row state.
	 *
	 * The embedding is NOT deleted here — that is the caller's job (see
	 * design: deleteVector is a separate method so a decay workflow can
	 * orchestrate archive + vector GC explicitly).
	 */
	markArchived(id: string): void {
		this.db.transaction(() => {
			this.db.prepare(`UPDATE memory_index SET archived = 1 WHERE id = ?`).run(id);
			// FTS5 mirror must drop the row in the same transaction so a
			// subsequent bm25Search cannot return an archived atom (principle
			// "archive / supersede 立即让 FTS5 行失效"). Vector GC is a
			// separate caller-driven step (deleteVector) and intentionally
			// NOT coupled here — the FTS5 sync is an archive invariant, the
			// vector delete is a storage-GC decision.
			this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(id);
			this.insertAudit(id, "archived", null);
		})();
	}

	/**
	 * Restore an archived atom to active state. Re-inserts the
	 * memory_fts row (which was deleted on archive) so BM25 search
	 * recovers immediately — the init() count-based repair would
	 * eventually fix it, but a manual unarchive should be instantly
	 * visible in search results.
	 *
	 * Intentionally NOT wrapped in a transaction with an audit row —
	 * the design says unarchive should not recompute or audit, since
	 * the original archived audit row is still present and sufficient
	 * to reconstruct history.
	 */
	markUnarchived(id: string): void {
		this.db.transaction(() => {
			this.db.prepare(`UPDATE memory_index SET archived = 0 WHERE id = ?`).run(id);
			// Re-insert the FTS5 row so BM25 search immediately surfaces
			// the atom. INSERT OR REPLACE handles the edge case where the
			// row somehow still exists.
			this.db
				.prepare(
					`INSERT OR REPLACE INTO memory_fts(id, title, summary, content, tags)
					 SELECT id, title, summary, content, COALESCE(tags, '')
					 FROM memory_index WHERE id = ?`,
				)
				.run(id);
		})();
	}

	/**
	 * Remove the embedding row for an atom. Idempotent: `DELETE` against
	 * a missing row affects zero rows. Decoupled from `markArchived` so
	 * callers can decide when (or whether) to free the vector (R27).
	 */
	deleteVector(id: string): void {
		this.db.prepare(`DELETE FROM memory_vectors WHERE id = ?`).run(id);
	}

	/**
	 * Return ids of all active + latest atoms that lack a vector in
	 * `memory_vectors`. These atoms cannot participate in the dense
	 * channel and will be invisible to hybrid recall unless BM25
	 * independently matches them.
	 */
	listMissingVectorIds(): string[] {
		const rows = this.db
			.prepare(
				`SELECT i.id FROM memory_index i
				 LEFT JOIN memory_vectors v ON i.id = v.id
				 WHERE v.id IS NULL AND i.is_latest = 1 AND i.archived = 0`,
			)
			.all() as Array<{ id: string }>;
		return rows.map((r) => r.id);
	}

	/**
	 * Return ids of all active + latest atoms whose stored `embed_text_version`
	 * is below `currentVersion`. These atoms have embeddings generated from a
	 * previous version of `buildEmbeddableText` (e.g. v1 included `content`,
	 * v2 dropped it) and need to be re-embedded to participate in recall with
	 * the current dense channel — otherwise the embedding direction is
	 * anchored to the old text set and can produce stale / cross-concept
	 * false positives (see `embed.ts:buildEmbeddableText` rationale).
	 *
	 * Used by the `session_start` maintenance hook to migrate existing atoms
	 * after a schema bump. The migration is incremental: only atoms whose
	 * stored version is stale are returned, so subsequent session_starts are
	 * no-ops once the migration completes.
	 */
	listStaleEmbedVersionIds(currentVersion: number): string[] {
		const rows = this.db
			.prepare(
				`SELECT id FROM memory_index
				 WHERE embed_text_version < ?
				   AND is_latest = 1
				   AND archived = 0`,
			)
			.all(currentVersion) as Array<{ id: string }>;
		return rows.map((r) => r.id);
	}

	/**
	 * Update the stored embed_text_version for an atom. Called by the
	 * `session_start` migration hook after re-embedding succeeds so the atom
	 * is no longer returned by `listStaleEmbedVersionIds` on the next run.
	 */
	setEmbedTextVersion(id: string, version: number): void {
		this.db
			.prepare(`UPDATE memory_index SET embed_text_version = ? WHERE id = ?`)
			.run(version, id);
	}

	/**
	 * Insert (or replace) the embedding vector for a single atom.
	 * Caller is responsible for generating the embedding — storage
	 * never touches the embedder.
	 *
	 * Note: `memory_vectors` is a sqlite-vec `vec0` virtual table which
	 * does NOT honour `INSERT OR REPLACE` — the unique constraint fires
	 * instead of deleting the prior row. We do an explicit DELETE before
	 * the INSERT to keep the call site simple (`upsertVector(id, embedding)`
	 * is idempotent regardless of whether a row already exists).
	 */
	upsertVector(id: string, embedding: number[]): void {
		this.db.prepare(`DELETE FROM memory_vectors WHERE id = ?`).run(id);
		this.db
			.prepare(`INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)`)
			.run(id, new Float32Array(embedding));
	}
}

// Single source of truth for the v2 memory schema. Applied via db.exec() in
// init(); every statement is `IF NOT EXISTS` so init() is idempotent.
//
// The idx_memory_active_fingerprint index is UNIQUE by design (R3): it is
// partial on (is_latest = 1 AND archived = 0) so that the same content can
// reappear in superseded or archived rows without violating the constraint.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_index (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('rule', 'fact', 'process')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  strength REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  is_latest INTEGER NOT NULL DEFAULT 1 CHECK (is_latest IN (0, 1)),
  parent_id TEXT,
  superseded_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_access INTEGER,
  content_fingerprint TEXT NOT NULL,
  source_session TEXT,
  embed_text_version INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_active_fingerprint
  ON memory_index(content_fingerprint)
  WHERE is_latest = 1 AND archived = 0;

CREATE INDEX IF NOT EXISTS idx_memory_active_recent
  ON memory_index(created_at DESC)
  WHERE is_latest = 1 AND archived = 0;

CREATE INDEX IF NOT EXISTS idx_memory_type
  ON memory_index(type)
  WHERE is_latest = 1 AND archived = 0;

CREATE INDEX IF NOT EXISTS idx_memory_superseded
  ON memory_index(is_latest, superseded_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_atom
  ON memory_audit(atom_id, created_at DESC);
`;

// FTS5 mirror of memory_index for keyword recall. The schema is fixed
// (Decision 1 in memory-v2-refactor / design.md): exactly five fields
// (id UNINDEXED, title, summary, content, tags) using the unicode61
// tokenizer with diacritics stripped.
//
// We deliberately do NOT use external-content mode (`content=''`):
// external-content FTS5 tables return NULL for every column on SELECT —
// including the UNINDEXED `id` column — which would break the
// `memory_fts v INNER JOIN memory_index i ON v.id = i.id` pattern that
// bm25Search (and any future keyword-side ranking) depends on to recover
// the atom id from a MATCH hit. The cost of this choice is that
// memory_fts duplicates the title/summary/content/tags text already
// stored in memory_index; for a personal-assistant scale (thousands of
// atoms) that is negligible compared to the join-correctness benefit.
//
// `tags` is the JSON-encoded TEXT column from memory_index. The unicode61
// tokenizer splits on whitespace + punctuation including `[` `]` `"`
// `,`, so `["amplicon","biomarker"]` tokenizes to amplicon + biomarker —
// callers searching by tag query the literal tag value and FTS5 matches.
// Do NOT add more fields here; the schema is the contract for downstream
// search code.
const MEMORY_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  content,
  tags,
  tokenize='unicode61 remove_diacritics 2'
)
`;

// re-export the row helpers so callers that only import from storage.ts do
// not need to know about types.ts. Phase 2.3 will use these internally; we
// keep the export now to avoid a public-API change later.
export { atomToRow, rowToAtom };
export type { MemoryAtom, MemoryAtomRow, MemoryAtomType };