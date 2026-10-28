import { DatabaseSync } from "node:sqlite";
import type { DurableObjectSqliteStorage } from "../../src/sqlite/cloudflare.ts";
import type { SqliteExecutor } from "../../src/sqlite/index.ts";

type SqlValue = ArrayBuffer | string | number | null;

/**
 * A stand-in for a SQLite-backed Durable Object's `ctx.storage` over `node:sqlite`, with its value types: `BLOB`
 * bindings and results are `ArrayBuffer`s, and `exec()` without bindings may run several statements. It keeps this
 * portable package free of Workers test dependencies; a Cloudflare host can run the same storage conformance suite
 * against its binding with `runInDurableObject()` from `cloudflare:test`.
 */
export function durableObjectStorage(
	database = new DatabaseSync(":memory:"),
	onCursorOperation?: (operation: "next" | "toArray") => void,
): DurableObjectSqliteStorage {
	const toNode = (value: SqlValue) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);
	const fromNode = (value: unknown): SqlValue =>
		value instanceof Uint8Array ? (value.slice().buffer as ArrayBuffer) : (value as SqlValue);
	const cursor = (rows: Record<string, SqlValue>[]) => {
		let index = 0;
		return {
			next(): { done: false; value: Record<string, SqlValue> } | { done: true } {
				onCursorOperation?.("next");
				const value = rows[index++];
				return value === undefined ? { done: true } : { done: false, value };
			},
			toArray(): Record<string, SqlValue>[] {
				onCursorOperation?.("toArray");
				const remaining = rows.slice(index);
				index = rows.length;
				return remaining;
			},
		};
	};
	return {
		sql: {
			exec(query, ...bindings) {
				if (bindings.length === 0 && query.trim().replace(/;\s*$/, "").includes(";")) {
					database.exec(query);
					return cursor([]);
				}
				const statement = database.prepare(query);
				if (statement.columns().length === 0) {
					statement.run(...bindings.map(toNode));
					return cursor([]);
				}
				const rows = (statement.all(...bindings.map(toNode)) as Record<string, unknown>[]).map((row) =>
					Object.fromEntries(Object.entries(row).map(([key, value]) => [key, fromNode(value)])),
				);
				return cursor(rows);
			},
		},
		async transaction(closure) {
			database.exec("BEGIN");
			try {
				const result = await closure();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

/**
 * The rows each kind of statement changes, as `runCounted` reports them: on a table with two indexes, so a driver that counted
 * index writes (a Durable Object cursor's `rowsWritten`) would report more.
 */
export async function runChanges(database: SqliteExecutor): Promise<Record<string, number>> {
	await database.exec(
		"CREATE TABLE changes_probe (id TEXT PRIMARY KEY, path TEXT NOT NULL, n INTEGER NOT NULL) STRICT, WITHOUT ROWID",
	);
	await database.exec("CREATE INDEX changes_probe_path ON changes_probe (path, id)");
	await database.exec("CREATE INDEX changes_probe_n ON changes_probe (n, id)");
	for (let i = 0; i < 10; i++) await database.run("INSERT INTO changes_probe VALUES (?, ?, ?)", `k${i}`, `a/${i}`, i);
	const changes = (sql: string, ...params: (string | number)[]) => database.runCounted(sql, ...params);
	return {
		insert: await changes("INSERT INTO changes_probe VALUES (?, ?, ?)", "x", "a/x", 99),
		update: await changes("UPDATE changes_probe SET path = ? WHERE id = ?", "b/x", "x"),
		none: await changes("UPDATE changes_probe SET n = 0 WHERE id = ?", "absent"),
		bulk: await changes("UPDATE changes_probe SET path = 'c/' || substr(path, 3) WHERE path >= 'a/' AND path < 'a0'"),
		upsert: await changes(
			"INSERT INTO changes_probe VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n",
			"x",
			"b/x",
			5,
		),
		delete: await changes("DELETE FROM changes_probe WHERE id = ?", "x"),
		bulkDelete: await changes("DELETE FROM changes_probe WHERE path >= 'c/' AND path < 'c0'"),
	};
}

/** What `runChanges` reports on every driver. */
export const RUN_CHANGES = { insert: 1, update: 1, none: 0, bulk: 10, upsert: 1, delete: 1, bulkDelete: 10 };
