// Store backends (slice 6a §2): what a store runs on. One kind today, any `SqliteDatabase` (Node through
// `chord/sqlite/node`, Durable Objects through `chord/sqlite/cloudflare`); its interface is internal to the store.

import type { SqliteDatabase } from "../sqlite/index.ts";

/** A backend for `openStore` and `importStore`: opaque to apps, owned by the store once given to it. */
export class Backend {
	/** The database the store runs its SQL on. */
	readonly db: SqliteDatabase;

	constructor(db: SqliteDatabase) {
		this.db = db;
	}
}

/**
 * A backend over a SQLite database (`openNodeSqliteDatabase(path)`, a Durable Object's storage, `:memory:` in tests).
 * The rows its `get` and `all` return are plain data: the store reads their columns, perhaps more than once, and the
 * database does not change a row after returning it. Every row of one statement enumerates the same columns, in the
 * same order (a result set's columns are the statement's, as node:sqlite's and a Durable Object's cursor's rows do).
 */
export function sqliteBackend(db: SqliteDatabase): Backend {
	return new Backend(db);
}
