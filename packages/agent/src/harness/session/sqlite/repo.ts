import type {
	FileSystem,
	Session,
	SqliteDatabase,
	SqliteEnv,
	SqliteSessionCreateOptions,
	SqliteSessionListOptions,
	SqliteSessionMetadata,
	SqliteSessionRepoApi,
} from "../../types.ts";
import { SessionError } from "../../types.ts";
import { createSessionId, getEntriesToFork, getFileSystemResultOrThrow, toSession } from "../repo-utils.ts";
import { SqliteSessionStorage } from "./storage.ts";

const SQLITE_SESSION_SCHEMA_VERSION = 1;

const SQLITE_SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	cwd TEXT NOT NULL,
	parent_session_id TEXT NULL,
	storage_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS session_entries (
	seq INTEGER PRIMARY KEY,
	session_id TEXT NOT NULL,
	id TEXT NOT NULL,
	parent_id TEXT NULL,
	type TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	payload TEXT NOT NULL CHECK (json_valid(payload)),
	target_id TEXT NULL,
	message_role TEXT NULL,
	custom_type TEXT NULL,
	UNIQUE (session_id, id)
);

CREATE INDEX IF NOT EXISTS idx_session_entries_session_seq ON session_entries(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_parent ON session_entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_type ON session_entries(session_id, type);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_target ON session_entries(session_id, target_id);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_message_role ON session_entries(session_id, message_role);

CREATE TABLE IF NOT EXISTS session_state (
	session_id TEXT PRIMARY KEY,
	leaf_id TEXT NULL,
	session_name TEXT NULL,
	model_provider TEXT NULL,
	model_id TEXT NULL,
	thinking_level TEXT NULL,
	active_tool_names TEXT NULL,
	latest_compaction_entry_id TEXT NULL,
	latest_compaction_first_kept_entry_id TEXT NULL,
	latest_compaction_tokens_before INTEGER NULL,
	compaction_count INTEGER NOT NULL DEFAULT 0,
	labels_json TEXT NULL,
	entry_count INTEGER NOT NULL DEFAULT 0,
	last_entry_seq INTEGER NULL,
	updated_at TEXT NOT NULL
);
`;

type SqliteSessionRepoEnv = Pick<FileSystem & SqliteEnv, "absolutePath" | "createDir" | "exists" | "openSqlite">;

function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

interface SessionRow {
	id: string;
	created_at: string;
	cwd: string;
	parent_session_id: string | null;
}

async function ensureSqliteSessionSchema(db: SqliteDatabase): Promise<void> {
	await db.exec("PRAGMA journal_mode=WAL");
	await db.exec("PRAGMA synchronous=NORMAL");
	await db.exec(SQLITE_SESSION_SCHEMA_SQL);
	const row = await db.prepare("SELECT version FROM schema_version LIMIT 1").get<{ version: number }>();
	if (!row) {
		await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run([SQLITE_SESSION_SCHEMA_VERSION]);
		return;
	}
	if (row.version !== SQLITE_SESSION_SCHEMA_VERSION) {
		throw new SessionError(
			"storage",
			`Unsupported SQLite session schema version ${row.version}; expected ${SQLITE_SESSION_SCHEMA_VERSION}`,
		);
	}
}

function toMetadata(row: SessionRow, path: string): SqliteSessionMetadata {
	return {
		id: row.id,
		createdAt: row.created_at,
		cwd: row.cwd,
		path,
		parentSessionId: row.parent_session_id ?? undefined,
	};
}

export class SqliteSessionRepo implements SqliteSessionRepoApi {
	private readonly env: SqliteSessionRepoEnv;
	private readonly databasePathInput: string;
	private databasePath: string | undefined;

	constructor(options: { env: SqliteSessionRepoEnv; databasePath: string }) {
		this.env = options.env;
		this.databasePathInput = options.databasePath;
	}

	private async getDatabasePath(): Promise<string> {
		if (!this.databasePath) {
			this.databasePath = getFileSystemResultOrThrow(
				await this.env.absolutePath(this.databasePathInput),
				`Failed to resolve SQLite sessions database ${this.databasePathInput}`,
			);
		}
		return this.databasePath;
	}

	private async ensureDatabaseDir(): Promise<void> {
		const path = await this.getDatabasePath();
		const directory = getParentPath(path);
		getFileSystemResultOrThrow(
			await this.env.createDir(directory, { recursive: true }),
			`Failed to create SQLite sessions directory ${directory}`,
		);
	}

	private async openDatabase(): Promise<SqliteDatabase> {
		await this.ensureDatabaseDir();
		const db = await this.env.openSqlite(await this.getDatabasePath());
		try {
			await ensureSqliteSessionSchema(db);
			return db;
		} catch (error) {
			await db.close();
			throw error;
		}
	}

	async create(options: SqliteSessionCreateOptions): Promise<Session<SqliteSessionMetadata>> {
		const db = await this.openDatabase();
		const id = options.id ?? createSessionId();
		const storage = await SqliteSessionStorage.create(db, await this.getDatabasePath(), {
			cwd: options.cwd,
			sessionId: id,
			parentSessionId: options.parentSessionId,
		});
		return toSession(storage);
	}

	async open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.env.exists(metadata.path), `Failed to check database ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const db = await this.openDatabase();
		const storage = await SqliteSessionStorage.open(db, metadata);
		return toSession(storage);
	}

	async list(options: SqliteSessionListOptions = {}): Promise<SqliteSessionMetadata[]> {
		const path = await this.getDatabasePath();
		if (!getFileSystemResultOrThrow(await this.env.exists(path), `Failed to check database ${path}`)) {
			return [];
		}
		const db = await this.openDatabase();
		try {
			const rows = options.cwd
				? await db
						.prepare(
							"SELECT id, created_at, cwd, parent_session_id FROM sessions WHERE cwd = ? ORDER BY created_at DESC",
						)
						.all<SessionRow>([options.cwd])
				: await db
						.prepare("SELECT id, created_at, cwd, parent_session_id FROM sessions ORDER BY created_at DESC")
						.all<SessionRow>();
			return rows.map((row) => toMetadata(row, path));
		} finally {
			await db.close();
		}
	}

	async delete(metadata: SqliteSessionMetadata): Promise<void> {
		const db = await this.openDatabase();
		try {
			await db.transaction(async () => {
				await db.prepare("DELETE FROM session_state WHERE session_id = ?").run([metadata.id]);
				await db.prepare("DELETE FROM session_entries WHERE session_id = ?").run([metadata.id]);
				const result = await db.prepare("DELETE FROM sessions WHERE id = ?").run([metadata.id]);
				if (result.changes === 0) {
					throw new SessionError("not_found", `Session not found: ${metadata.id}`);
				}
			});
		} finally {
			await db.close();
		}
	}

	async fork(
		sourceMetadata: SqliteSessionMetadata,
		options: SqliteSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<SqliteSessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const id = options.id ?? createSessionId();
		const storage = await SqliteSessionStorage.create(await this.openDatabase(), await this.getDatabasePath(), {
			cwd: options.cwd,
			sessionId: id,
			parentSessionId: options.parentSessionId ?? sourceMetadata.id,
		});
		for (const entry of forkedEntries) {
			await storage.appendEntry(entry);
		}
		return toSession(storage);
	}
}
