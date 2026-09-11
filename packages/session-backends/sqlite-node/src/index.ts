import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { sql } from "./sqlite/sql.ts";
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

	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.iterate(first, ...(rest as SQLInputValue[]))
				: this.statement.iterate(...(params as SQLInputValue[]))
		) as Iterable<TRow>;
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
		sql`BEGIN IMMEDIATE`.exec(this);
		try {
			const result = fn();
			if (isAsyncResult(result)) {
				throw new TypeError("SQLite transaction callbacks must be synchronous");
			}
			sql`COMMIT`.exec(this);
			return result;
		} catch (error) {
			try {
				sql`ROLLBACK`.exec(this);
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
		async openExisting(path: string): Promise<SqliteDatabase> {
			const url = pathToFileURL(path);
			url.searchParams.set("mode", "rw");
			return new NodeSqliteDatabase(new DatabaseSync(url));
		},
		async openReadOnly(path: string): Promise<SqliteDatabase> {
			return new NodeSqliteDatabase(new DatabaseSync(path, { readOnly: true }));
		},
	};
}

// Re-export the SQLite session backend and types so this package is a complete node-sqlite backend.
export * from "./sqlite/index.ts";
