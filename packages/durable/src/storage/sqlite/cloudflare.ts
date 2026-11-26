import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@earendil-works/chord/sqlite/cloudflare";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";

export { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@earendil-works/chord/sqlite/cloudflare";

/**
 * Open durable storage on a SQLite-backed Durable Object, optionally under a table prefix. Calls given the same
 * storage object share an operation queue.
 */
export function openDurableObjectSqliteStorage(
	storage: DurableObjectSqliteStorage,
	options: SqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(new DurableObjectSqliteDatabase(storage), options);
}
