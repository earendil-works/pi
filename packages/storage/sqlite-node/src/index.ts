import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "./sqlite/types.ts";

function isNamedParameters(value: unknown): value is Record<string, SQLInputValue> {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	return true;
}

function isAsyncResult(value: unknown): boolean {
	return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value;
}

class NodeSqliteStatement implements SqliteStatement {
	private readonly statement: ReturnType<DatabaseSync["prepare"]>;

	constructor(statement: ReturnType<DatabaseSync["prepare"]>) {
		this.statement = statement;
	}

	run(...params: unknown[]): SqliteRunResult {
		const [first, ...rest] = params;
		const result = isNamedParameters(first)
			? this.statement.run(first, ...(rest as SQLInputValue[]))
			: this.statement.run(...(params as SQLInputValue[]));
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.get(first, ...(rest as SQLInputValue[]))
				: this.statement.get(...(params as SQLInputValue[]))
		) as TRow | undefined;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
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

	exec(sql: string): void {
		this.db.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return new NodeSqliteStatement(this.db.prepare(sql));
	}

	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			if (isAsyncResult(result)) {
				throw new TypeError("SQLite transaction callbacks must be synchronous");
			}
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

	close(): void {
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

// Re-export the SQLite session backend and types so this package is a complete node-sqlite backend.
export * from "./sqlite/index.ts";
