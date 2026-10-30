/// <reference lib="dom" />

// The IndexedDB database where pi-connect keeps credentials, model catalogs and auth documents.

export type StoreName = "credentials" | "models" | "documents";

const STORES: readonly StoreName[] = ["credentials", "models", "documents"];

const DATABASE_VERSION = 1;

/** One open pi-connect database: key-value stores of structured-cloned values. */
export class ConnectDatabase {
	private readonly db: IDBDatabase;

	private constructor(db: IDBDatabase) {
		this.db = db;
	}

	/** Open (and on first use create) the database `name`. */
	static open(name: string, factory: IDBFactory = indexedDB): Promise<ConnectDatabase> {
		const request = factory.open(name, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			for (const store of STORES) {
				if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
			}
		};
		return settle(request).then((db) => new ConnectDatabase(db));
	}

	/** Read one value. */
	get(store: StoreName, key: string): Promise<unknown> {
		return settle(this.db.transaction(store, "readonly").objectStore(store).get(key));
	}

	/** List the keys of a store. */
	async keys(store: StoreName): Promise<string[]> {
		const keys = await settle(this.db.transaction(store, "readonly").objectStore(store).getAllKeys());
		return keys.map(String);
	}

	/** Write one value; resolves once the write is committed. */
	put(store: StoreName, key: string, value: unknown): Promise<void> {
		return this.write(store, (objects) => objects.put(value, key));
	}

	/** Delete one value; resolves once the deletion is committed. */
	delete(store: StoreName, key: string): Promise<void> {
		return this.write(store, (objects) => objects.delete(key));
	}

	/** Close the connection. */
	close(): void {
		this.db.close();
	}

	private write(store: StoreName, change: (objects: IDBObjectStore) => void): Promise<void> {
		const transaction = this.db.transaction(store, "readwrite");
		change(transaction.objectStore(store));
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		});
	}
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
