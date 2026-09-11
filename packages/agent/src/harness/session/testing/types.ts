import type { Storage } from "../types.ts";

/** A fresh backend storage instance owned by one test or benchmark case. */
export interface StorageFixture extends AsyncDisposable {
	readonly storage: Storage;
}

/** A runner-independent conformance case that can be registered with any test framework. */
export interface ConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
