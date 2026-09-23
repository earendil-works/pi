import type { Storage } from "../types.ts";

export interface StorageConformanceAssertions {
	ok(value: unknown, message?: string): void;
	strictEqual(actual: unknown, expected: unknown): void;
	deepEqual(actual: unknown, expected: unknown): void;
	partialDeepEqual(actual: unknown, expected: unknown): void;
	greaterThan(actual: number, expected: number): void;
	rejects(operation: Promise<unknown>, messageIncludes: string): Promise<void>;
}

export type StorageConformanceProvider = (use: (storage: Storage) => Promise<void>) => Promise<void>;

export interface StorageConformanceOptions {
	readonly assertions: StorageConformanceAssertions;
	readonly withStorage: StorageConformanceProvider;
}

export interface StorageConformanceCase {
	readonly name: string;
	run(): Promise<void>;
}
