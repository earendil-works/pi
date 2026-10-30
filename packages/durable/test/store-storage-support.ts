// StoreStorage over a SQLite file for tests: a store opened on the file, Durable's storage in it under a test owner
// name, and a close that closes the store too (the app's part: in tests the storage is the store's only owner).

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openStore, sqliteBackend } from "@earendil-works/chord/next";
import { type NodeSqliteDatabaseOptions, openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { StoreStorage } from "../src/storage/store/index.ts";
import type { Storage } from "../src/types.ts";

/** The owner name the test storages use. */
export const TEST_OWNER = "durable.test";

/** A `StoreStorage` on a store over the SQLite file at `path` (`:memory:` too) whose `close` closes the store too. */
export async function openStoreStorage(path: string, options: NodeSqliteDatabaseOptions = {}): Promise<Storage> {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path, options)), BACKGROUND_CONTEXT);
	let storage: StoreStorage;
	try {
		storage = await StoreStorage.open(store, TEST_OWNER, BACKGROUND_CONTEXT);
	} catch (error) {
		await store.close(BACKGROUND_CONTEXT);
		throw error;
	}
	let closing: Promise<void> | undefined;
	const close = (context: Parameters<Storage["close"]>[0]): Promise<void> => {
		closing ??= storage.close(context).then(() => store.close(context));
		return closing;
	};
	// StoreStorage keeps its state in private fields: its methods run on the storage itself, bound once.
	const bound = new Map<PropertyKey, unknown>([["close", close]]);
	return new Proxy(storage, {
		get(target, property) {
			let value = bound.get(property);
			if (value !== undefined) return value;
			value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			value = value.bind(target);
			bound.set(property, value);
			return value;
		},
		// A test replacing a method (`storage.commit = …`) gets its own on the next read.
		set(target, property, value) {
			bound.delete(property);
			return Reflect.set(target, property, value, target);
		},
	});
}
