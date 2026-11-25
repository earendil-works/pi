// A session's Durable records in its Chord store: `StoreStorage` under p2's owner name, beside the kit's `Files`
// (tables `p2.durable:*` and `chord.app.files:*` in one store). The worker opens it over the store its host runs on;
// offline tools (the migration, tests, reports) open a stopped session's store with `openSessionStorage`.
import type { Store } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import { openHostStore, sessionDirectory } from "./host-dirs.ts";

/** The owner name of a session's Durable records in its store: its tables and document namespaces are claimed under it. */
export const DURABLE_OWNER = "p2.durable";

/** Durable's storage in the session store `store`. */
export function durableStorage(store: Store, context: Context): Promise<StoreStorage> {
	return StoreStorage.open(store, DURABLE_OWNER, context);
}

/**
 * Opens the store of the stopped session `id` (no worker may run it: one process per store) and its Durable storage;
 * `close` closes both.
 */
export async function openSessionStorage(
	dataDir: string,
	id: string,
	context: Context,
): Promise<{ readonly store: Store; readonly storage: StoreStorage; close(): Promise<void> }> {
	// The stored outbox setting stays: turning an outbox off would drop commits the backup does not hold yet.
	const store = await openHostStore(sessionDirectory(dataDir, id), {}, context);
	try {
		const storage = await durableStorage(store, context);
		return {
			store,
			storage,
			close: async () => {
				await storage.close(context);
				await store.close(context);
			},
		};
	} catch (error) {
		await store.close(context);
		throw error;
	}
}
