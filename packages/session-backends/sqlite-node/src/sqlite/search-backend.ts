import type {
	FileError,
	Result,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
} from "@earendil-works/pi-agent-core";
import { SessionError } from "@earendil-works/pi-agent-core";
import { applyMigrations } from "./migrations.ts";
import { sql } from "./sql.ts";
import { decodeSessionMetadata, type SessionRow } from "./storage/sessions.ts";
import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteSessionMetadata,
	SqliteSessionRepositoryEnv,
} from "./types.ts";

function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	throw error;
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

function rebuildSearchIndex(db: SqliteDatabase): void {
	sql`INSERT INTO session_search_fts(session_search_fts) VALUES('rebuild')`.run(db);
}

function ensureSearchSchema(db: SqliteDatabase): void {
	const ftsExists = tableExists(db, "session_search_fts");
	const entriesExist = tableExists(db, "entries");
	db.transaction(() => {
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
		if (!ftsExists && entriesExist) rebuildSearchIndex(db);
	});
}

export interface SqliteSessionSearchHit extends SessionSearchHit {
	readonly metadata: SqliteSessionMetadata;
	readonly timestamp: number;
	readonly score: number;
}

/** SQLite FTS search over a co-located canonical session database. */
class SqliteSessionSearch implements SessionSearch<SqliteSessionSearchHit> {
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

	async *search(text: string, options: SessionSearchOptions = {}): AsyncIterable<SqliteSessionSearchHit> {
		const queryText = text.trim();
		if (!queryText || (options.limit !== undefined && options.limit <= 0)) return;
		if (options.entryTypes?.length === 0) return;
		throwIfAborted(options.signal);
		const db = await this.openDatabase();
		try {
			const query = `"${queryText.replaceAll('"', '""')}"`;
			const predicates = ["session_search_fts MATCH ?"];
			const params: unknown[] = [query];
			if (options.entryTypes !== undefined) {
				predicates.push(`se.type IN (${options.entryTypes.map(() => "?").join(", ")})`);
				params.push(...options.entryTypes);
			}
			const rows = db
				.prepare(
					`SELECT s.id, s.created_at, s.metadata, s.cwd, s.parent_session_id,
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
					WHERE ${predicates.join(" AND ")}
					ORDER BY score
					LIMIT ?`,
				)
				.iterate<SessionRow & { entry_id: string; timestamp: number; score: number }>(
					...params,
					options.limit ?? -1,
				);
			const path = await this.getDatabasePath();
			for (const row of rows) {
				throwIfAborted(options.signal);
				yield {
					sessionId: row.id,
					metadata: decodeSessionMetadata(row, path),
					entryId: row.entry_id,
					timestamp: row.timestamp,
					score: row.score,
				};
			}
		} finally {
			db.close();
		}
	}
}

export function createSqliteSessionSearch(options: SqliteSessionSearchOptions): SessionSearch<SqliteSessionSearchHit> {
	return new SqliteSessionSearch(options);
}
