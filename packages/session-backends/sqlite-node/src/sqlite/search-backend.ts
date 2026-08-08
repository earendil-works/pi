import type { SessionSearch, SessionSearchHit, SessionSearchOptions } from "@earendil-works/pi-agent-core";
import { getFileSystemResultOrThrow } from "@earendil-works/pi-agent-core";
import { applyMigrations } from "./migrations.ts";
import { sql } from "./sql.ts";
import { decodeSessionMetadata, type SessionRow } from "./storage/sessions.ts";
import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteSessionMetadata,
	SqliteSessionRepositoryEnv,
} from "./types.ts";

function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

function configureSqliteDatabase(db: SqliteDatabase): void {
	sql`PRAGMA journal_mode=WAL`.exec(db);
	sql`PRAGMA synchronous=FULL`.exec(db);
	sql`PRAGMA busy_timeout=5000`.exec(db);
}

export interface SqliteSessionSearchOptions {
	env: Pick<SqliteSessionRepositoryEnv, "absolutePath" | "createDir">;
	sqlite: SqliteDatabaseFactory;
	databasePath: string;
}

function tableExists(db: SqliteDatabase, name: string): boolean {
	return !!sql`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${name} LIMIT 1`.get<{
		found: number;
	}>(db);
}

function ensureSearchSchema(db: SqliteDatabase): void {
	const ftsExists = tableExists(db, "session_search_fts");
	sql`
CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
  payload,
  content = 'entries',
  content_rowid = 'rowid',
  tokenize = 'trigram remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS session_search_fts_ai AFTER INSERT ON entries BEGIN
  INSERT INTO session_search_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
CREATE TRIGGER IF NOT EXISTS session_search_fts_ad AFTER DELETE ON entries BEGIN
  INSERT INTO session_search_fts(session_search_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
END;
CREATE TRIGGER IF NOT EXISTS session_search_fts_au AFTER UPDATE OF payload ON entries BEGIN
  INSERT INTO session_search_fts(session_search_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
  INSERT INTO session_search_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
`.exec(db);
	if (!ftsExists) sql`INSERT INTO session_search_fts(session_search_fts) VALUES('rebuild')`.exec(db);
}

/** SQLite FTS search over a co-located canonical session database. */
class SqliteSessionSearch implements SessionSearch<SqliteSessionMetadata> {
	private readonly options: SqliteSessionSearchOptions;
	private databasePath: string | undefined;

	constructor(options: SqliteSessionSearchOptions) {
		this.options = options;
	}

	private async getDatabasePath(): Promise<string> {
		if (!this.databasePath) {
			this.databasePath = getFileSystemResultOrThrow(
				await this.options.env.absolutePath(this.options.databasePath),
				`Failed to resolve SQLite search database ${this.options.databasePath}`,
			);
		}
		return this.databasePath;
	}

	private async openDatabase(): Promise<SqliteDatabase> {
		const path = await this.getDatabasePath();
		const directory = getParentPath(path);
		getFileSystemResultOrThrow(
			await this.options.env.createDir(directory, { recursive: true }),
			`Failed to create SQLite search directory ${directory}`,
		);
		const db = await this.options.sqlite.open(path);
		try {
			configureSqliteDatabase(db);
			await applyMigrations(db);
			ensureSearchSchema(db);
			return db;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<SqliteSessionMetadata>[]> {
		const text = options.text.trim();
		if (!text) return [];
		const db = await this.openDatabase();
		try {
			const query = `"${text.replaceAll('"', '""')}"`;
			const cwd = options.cwd ?? null;
			const rows = sql`SELECT s.id, s.created_at, s.metadata, s.cwd, s.parent_session_id,
				name_fact.seq IS NOT NULL AS has_session_name,
				name_fact.value AS session_name,
				se.id AS entry_id, se.timestamp, bm25(session_search_fts) AS score
			FROM session_search_fts
			JOIN entries AS se ON se.rowid = session_search_fts.rowid
			JOIN sessions AS s ON s.id = se.session_id
			LEFT JOIN facts AS name_fact
				ON name_fact.session_id = s.id
				AND name_fact.kind = 'name'
				AND name_fact.key IS NULL
				AND name_fact.seq = (
					SELECT MAX(f.seq)
					FROM facts AS f
					WHERE f.session_id = s.id AND f.kind = 'name' AND f.key IS NULL
				)
			WHERE session_search_fts MATCH ${query} AND (${cwd} IS NULL OR s.cwd = ${cwd})
			ORDER BY score`.all<SessionRow & { entry_id: string; timestamp: string; score: number }>(db);
			const path = await this.getDatabasePath();
			return rows.map((row) => ({
				metadata: decodeSessionMetadata(row, path),
				entryId: row.entry_id,
				timestamp: row.timestamp,
				score: row.score,
			}));
		} finally {
			db.close();
		}
	}
}

export function createSqliteSessionSearch(options: SqliteSessionSearchOptions): SessionSearch<SqliteSessionMetadata> {
	return new SqliteSessionSearch(options);
}
