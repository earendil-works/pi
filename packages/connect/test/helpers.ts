/// <reference lib="dom" />

// Test doubles for the browser APIs pi-connect uses: Web Locks and a fresh IndexedDB.

import { IDBFactory } from "fake-indexeddb";
import { ConnectDatabase } from "../src/database.ts";

/** A LockManager with one queue per lock name, like `navigator.locks` within an origin. */
export function memoryLocks(): LockManager {
	const tails = new Map<string, Promise<void>>();
	const request = async <T>(
		name: string,
		options: LockOptions,
		callback: (lock: Lock | null) => T | PromiseLike<T>,
	): Promise<T> => {
		const previous = tails.get(name) ?? Promise.resolve();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		tails.set(
			name,
			previous.then(() => held),
		);
		const signal = options.signal;
		if (signal) {
			const aborted = new Promise<never>((_, reject) => {
				if (signal.aborted) reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			try {
				await Promise.race([previous, aborted]);
			} catch (error) {
				// A cancelled waiter still takes its turn in the queue, but gives it back at once.
				void previous.then(release);
				throw error;
			}
		} else {
			await previous;
		}
		try {
			return await callback({ name, mode: "exclusive" });
		} finally {
			release();
		}
	};
	// LockManager's overloads cannot be implemented by one typed function; pi-connect calls the
	// (name, options, callback) form only.
	return { request, query: async () => ({ held: [], pending: [] }) } as unknown as LockManager;
}

let databases = 0;

/** Open a database in a fresh in-memory IndexedDB. */
export async function freshDatabase(): Promise<{ database: ConnectDatabase; factory: IDBFactory; name: string }> {
	const factory = new IDBFactory();
	const name = `test-${++databases}`;
	return { database: await ConnectDatabase.open(name, factory), factory, name };
}
