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
 * The store deletes rows and revisions; the bytes of freed pages and of the WAL are the connection's: an app that must
 * erase opens it with `PRAGMA secure_delete = ON` and checkpoints the WAL; Durable Objects own their storage.
 */
export function sqliteBackend(db: SqliteDatabase): Backend {
	return new Backend(db);
}
