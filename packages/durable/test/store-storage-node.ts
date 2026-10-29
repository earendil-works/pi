// What `vitest.store.config.ts` puts in the place of `../src/storage/sqlite/node.ts`: the same exports, with
// `openNodeSqliteStorage(path)` opening Durable's storage on Chord's store over that file (`StoreStorage`), so the
// harness test files that take a SQLite storage run unchanged on the store.

import type { NodeSqliteDatabaseOptions } from "@earendil-works/chord/sqlite/node";
import type { SqliteStorageOptions } from "../src/storage/sqlite/index.ts";
import type { Storage } from "../src/types.ts";
import { openStoreStorage } from "./store-storage-support.ts";

export {
	NodeSqliteDatabase,
	type NodeSqliteDatabaseOptions,
	openNodeSqliteDatabase,
} from "@earendil-works/chord/sqlite/node";

/** Node SQLite connection settings plus durable storage options, as the original takes them. */
export type NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & SqliteStorageOptions;

/** A `StoreStorage` on a store over the file at `path`; a table prefix becomes nothing (the owner name separates). */
export function openNodeSqliteStorage(path: string, options: NodeSqliteStorageOptions = {}): Promise<Storage> {
	const { prefix: _prefix, ...database } = options;
	return openStoreStorage(path, database);
}
