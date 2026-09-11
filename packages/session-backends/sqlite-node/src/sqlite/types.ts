/** Result of a prepared SQLite statement execution. */
export interface SqliteRunResult {
	changes: number;
	lastInsertRowid?: number;
}

/** Prepared SQLite statement capability used by the SQLite session backend. */
export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get<TRow extends object>(...params: unknown[]): TRow | undefined;
	all<TRow extends object>(...params: unknown[]): TRow[];
	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow>;
}

/** SQLite database capability used by the SQLite session backend. */
export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	/** Runs a synchronous write transaction. The callback must not return a promise. */
	transaction<T>(callback: () => T): T;
	close(): void;
}

export interface SqliteDatabaseFactory {
	/** Open a writable database, creating it when absent. */
	open(path: string): Promise<SqliteDatabase>;
	/** Open a writable database without creating it. */
	openExisting(path: string): Promise<SqliteDatabase>;
	/** Open an existing database read-only. */
	openReadOnly(path: string): Promise<SqliteDatabase>;
}
