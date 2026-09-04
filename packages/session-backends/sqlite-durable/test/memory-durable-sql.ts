import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DurableSqlCursor, DurableSqliteStorage } from "../src/types.ts";

function isSelectLike(query: string): boolean {
	return /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
}

function cursorFromRows<T extends Record<string, unknown>>(rows: T[], rowsWritten = 0): DurableSqlCursor<T> {
	return {
		toArray: () => rows,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
		rowsRead: rows.length,
		rowsWritten,
	};
}

/** Node `node:sqlite` stand-in for Cloudflare `ctx.storage` SQL + `transactionSync`. */
export function createMemoryDurableSqliteStorage(): DurableSqliteStorage {
	const db = new DatabaseSync(":memory:");
	return {
		sql: {
			exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
				const trimmed = query.trim();
				if (bindings.length === 0 && !isSelectLike(trimmed)) {
					db.exec(trimmed);
					return cursorFromRows<T>([]);
				}
				const statement = db.prepare(trimmed);
				const params = bindings as SQLInputValue[];
				if (isSelectLike(trimmed)) {
					const rows = (params.length > 0 ? statement.all(...params) : statement.all()) as T[];
					return cursorFromRows(rows);
				}
				const result = statement.run(...params);
				return cursorFromRows<T>([], Number(result.changes));
			},
		},
		transactionSync<T>(closure: () => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = closure();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// Keep the original error.
				}
				throw error;
			}
		},
	};
}
