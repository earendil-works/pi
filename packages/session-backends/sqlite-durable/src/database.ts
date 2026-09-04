import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteRunResult,
	SqliteStatement,
} from "@earendil-works/pi-session-backend-sqlite-node/sqlite";
import type { DurableSqliteStorage, DurableSqlStorage } from "./types.ts";

function isNamedParameters(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function positionalParams(params: unknown[]): unknown[] {
	const [first, ...rest] = params;
	if (isNamedParameters(first)) {
		throw new TypeError("Durable Object SQL supports positional parameters only");
	}
	if (rest.some((value) => isNamedParameters(value))) {
		throw new TypeError("Durable Object SQL supports positional parameters only");
	}
	return params;
}

class DurableSqliteStatement implements SqliteStatement {
	private readonly sql: DurableSqlStorage;
	private readonly query: string;

	constructor(sql: DurableSqlStorage, query: string) {
		this.sql = sql;
		this.query = query;
	}

	run(...params: unknown[]): SqliteRunResult {
		const cursor = this.sql.exec(this.query, ...positionalParams(params));
		return { changes: Number(cursor.rowsWritten ?? 0) };
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		return this.sql.exec<TRow & Record<string, unknown>>(this.query, ...positionalParams(params)).toArray()[0] as
			| TRow
			| undefined;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
		return this.sql.exec<TRow & Record<string, unknown>>(this.query, ...positionalParams(params)).toArray() as TRow[];
	}

	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		return this.sql.exec<TRow & Record<string, unknown>>(
			this.query,
			...positionalParams(params),
		) as unknown as Iterable<TRow>;
	}
}

class DurableSqliteDatabase implements SqliteDatabase {
	private readonly sql: DurableSqlStorage;
	private readonly storage: DurableSqliteStorage;

	constructor(storage: DurableSqliteStorage) {
		this.sql = storage.sql;
		this.storage = storage;
	}

	exec(sql: string): void {
		this.sql.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return new DurableSqliteStatement(this.sql, sql);
	}

	transaction<T>(callback: () => T): T {
		return this.storage.transactionSync(callback);
	}

	close(): void {
		// The Durable Object owns the database for the isolate lifetime.
	}
}

/** Wraps Durable Object SQL as the sqlite-node `SqliteDatabase` contract. */
export function wrapDurableSqlite(storage: DurableSqliteStorage): SqliteDatabase {
	return new DurableSqliteDatabase(storage);
}

/**
 * Factory that always returns the same Durable Object database.
 * Paths are ignored: one isolate has one SQLite file.
 */
export function createDurableSqliteFactory(storage: DurableSqliteStorage): SqliteDatabaseFactory {
	const db = wrapDurableSqlite(storage);
	return {
		async open(_path: string): Promise<SqliteDatabase> {
			return db;
		},
		async openExisting(_path: string): Promise<SqliteDatabase> {
			return db;
		},
		async openReadOnly(_path: string): Promise<SqliteDatabase> {
			return db;
		},
	};
}
