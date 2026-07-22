import type { FileSystem, SessionCreateOptions, SessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core";

/** Result of a prepared SQLite statement execution. */
export interface SqliteRunResult {
	/** Number of rows changed by the statement. */
	changes: number;
	/** Inserted row id when the backend exposes one. */
	lastInsertRowid?: number;
}

/** Prepared SQLite statement capability used by the SQLite session backend. */
export interface SqliteStatement {
	run(...params: unknown[]): Promise<SqliteRunResult>;
	get<TRow extends object>(...params: unknown[]): Promise<TRow | undefined>;
	all<TRow extends object>(...params: unknown[]): Promise<TRow[]>;
}

/** SQLite database capability used by the SQLite session backend. */
export interface SqliteDatabase {
	exec(sql: string): Promise<void>;
	prepare(sql: string): SqliteStatement;
	transaction<T>(fn: () => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export interface SqliteDatabaseFactory {
	open(path: string): Promise<SqliteDatabase>;
}

export interface SqliteSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionListOptions {
	cwd?: string;
}

export interface SqliteSessionBackendOptions {
	kind: "sqlite";
	databasePath: string;
}

export interface SqliteSessionRepoApi
	extends SessionRepo<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions> {}

export type SqliteSessionRepoEnv = Pick<FileSystem, "absolutePath" | "createDir" | "exists">;
