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
		run(...params: unknown[]): unknown;
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

	// Phase 2.4 will add: vectorSearch, findMostSimilarEmbedding.
	// Phase 2.5 will add: markSupersededTx, insertAudit.
	// Phase 2.6 will add: updateAccess, updateStrength, markArchived, deleteVector.
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