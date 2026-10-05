import type { ExecutionEnv } from "../env/index.ts";
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

export type EnvConformanceAssertions = StorageConformanceAssertions;

/** Calls `use` once with an environment whose `cwd` is a fresh, empty, writable directory, then cleans up. */
export type EnvConformanceProvider = (use: (env: ExecutionEnv) => Promise<void>) => Promise<void>;

export interface EnvConformanceOptions {
	readonly assertions: EnvConformanceAssertions;
	readonly withEnv: EnvConformanceProvider;
	/** Program and flag that run a POSIX shell script from the next argument; default `["sh", "-c"]`. */
	readonly shell?: readonly string[];
	/** Whether the shell's `ln -s` creates symbolic links; default true. */
	readonly symlinks?: boolean;
}

export interface EnvConformanceCase {
	readonly name: string;
	/** Cases that wait for an environment's watch latency need longer than a test runner's default timeout. */
	readonly timeoutMs?: number;
	run(): Promise<void>;
}
