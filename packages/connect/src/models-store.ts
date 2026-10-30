// pi-ai's ModelsStore in IndexedDB: the model catalogs providers refreshed, kept across page loads.

import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";
import type { ConnectDatabase } from "./database.ts";

/**
 * Catalogs are caches: two tabs writing one provider's catalog both write a valid catalog, so the
 * last write wins and no lock is needed. pi-ai serializes a provider's writes within one page.
 */
export class IndexedDbModelsStore implements ModelsStore {
	private readonly database: ConnectDatabase;

	constructor(database: ConnectDatabase) {
		this.database = database;
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		// Only this store writes the models store of its database.
		return (await this.database.get("models", providerId)) as ModelsStoreEntry | undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.database.put("models", providerId, entry);
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.database.delete("models", providerId);
	}
}
