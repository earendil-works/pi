import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "./sqlite/types.ts";

function isNamedParameters(value: unknown): value is Record<string, SQLInputValue> {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	return true;
}

class NodeSqliteStatement implements SqliteStatement {
	private readonly statement: ReturnType<DatabaseSync["prepare"]>;

	constructor(statement: ReturnType<DatabaseSync["prepare"]>) {
		this.statement = statement;
	}

	async run(...params: unknown[]): Promise<SqliteRunResult> {
		const [first, ...rest] = params;
		const result = isNamedParameters(first)
			? this.statement.run(first, ...(rest as SQLInputValue[]))
			: this.statement.run(...(params as SQLInputValue[]));
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	async get<TRow extends object>(...params: unknown[]): Promise<TRow | undefined> {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.get(first, ...(rest as SQLInputValue[]))
				: this.statement.get(...(params as SQLInputValue[]))
		) as TRow | undefined;
	}

	async all<TRow extends object>(...params: unknown[]): Promise<TRow[]> {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.all(first, ...(rest as SQLInputValue[]))
				: this.statement.all(...(params as SQLInputValue[]))
		) as TRow[];
	}
}

class NodeSqliteDatabase implements SqliteDatabase {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	async exec(sql: string): Promise<void> {
		this.db.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return new NodeSqliteStatement(this.db.prepare(sql));
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		this.db.exec("BEGIN");
		try {
			const result = await fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// Ignore rollback errors to rethrow original error.
			}
			throw error;
		}
	}

	async close(): Promise<void> {
		this.db.close();
	}
}

export function wrapNodeSqliteDatabase(db: DatabaseSync): SqliteDatabase {
	return new NodeSqliteDatabase(db);
}

export function createNodeSqliteFactory(): SqliteDatabaseFactory {
	return {
		async open(path: string): Promise<SqliteDatabase> {
			return new NodeSqliteDatabase(new DatabaseSync(path));
		},
	};
}

// Re-export the SQLite session storage backend and types so this package is a complete node-sqlite backend.
export * from "./sqlite/index.ts";
