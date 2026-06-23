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

	// -------------------------------------------------------------------------
	// Phase 2.4: vector search
	// -------------------------------------------------------------------------

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
		const whereClauses: string[] = ["archived = 0"];
		if (filter?.type) whereClauses.push("type = ?");
		if (filter?.isLatestOnly !== false) whereClauses.push("is_latest = 1");
		if (filter?.archived === true) {
			// explicit override — include archived too
			whereClauses.length = 0;
		}

		const sql = `
			SELECT v.id, v.distance
			FROM memory_vectors v
			INNER JOIN memory_index i ON v.id = i.id
			WHERE ${whereClauses.join(" AND ")}
			AND v.embedding MATCH ?
			AND k = ?
			ORDER BY v.distance
		`;
		const params: (string | number | Float32Array)[] = [];
		if (filter?.type) params.push(filter.type);
		params.push(new Float32Array(embedding));
		params.push(k);

		type Row = { id: string; distance: number };
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
			this.insertAudit(id, "archived", null);
		})();
	}

	/**
	 * Restore an archived atom to active state. Intentionally NOT wrapped
	 * in a transaction with an audit row — the design says unarchive
	 * should not recompute or audit, since the original archived audit
	 * row is still present and sufficient to reconstruct history.
	 */
	markUnarchived(id: string): void {
		this.db.prepare(`UPDATE memory_index SET archived = 0 WHERE id = ?`).run(id);
	}

	/**
	 * Remove the embedding row for an atom. Idempotent: `DELETE` against
	 * a missing row affects zero rows. Decoupled from `markArchived` so
	 * callers can decide when (or whether) to free the vector (R27).
	 */
	deleteVector(id: string): void {
		this.db.prepare(`DELETE FROM memory_vectors WHERE id = ?`).run(id);
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
  source_session TEXT
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

// re-export the row helpers so callers that only import from storage.ts do
// not need to know about types.ts. Phase 2.3 will use these internally; we
// keep the export now to avoid a public-API change later.
export { atomToRow, rowToAtom };
export type { MemoryAtom, MemoryAtomRow, MemoryAtomType };