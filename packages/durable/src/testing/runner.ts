import { createExpectAssertions, type ExpectLike } from "./assertions.ts";
import { createEnvConformance } from "./env-conformance.ts";
import { createStorageConformance } from "./storage-conformance.ts";
import type { EnvConformanceOptions, EnvConformanceProvider, StorageConformanceProvider } from "./types.ts";

export interface StorageConformanceRunner {
	readonly describe: (name: string, suite: () => void) => unknown;
	readonly expect: ExpectLike;
	readonly it: (name: string, test: () => Promise<void>, timeoutMs?: number) => unknown;
}

/** Registers the runner-independent cases with a Vitest/Jest-compatible test runner. */
export function registerStorageConformance(
	runner: StorageConformanceRunner,
	name: string,
	withStorage: StorageConformanceProvider,
): void {
	const cases = createStorageConformance({
		assertions: createExpectAssertions(runner.expect),
		withStorage,
	});
	runner.describe(name, () => {
		for (const testCase of cases) runner.it(testCase.name, testCase.run);
	});
}

/** Registers the runner-independent `ExecutionEnv` cases with a Vitest/Jest-compatible test runner. */
export function registerEnvConformance(
	runner: StorageConformanceRunner,
	name: string,
	withEnv: EnvConformanceProvider,
	options: Pick<EnvConformanceOptions, "shell" | "symlinks"> = {},
): void {
	const cases = createEnvConformance({ ...options, assertions: createExpectAssertions(runner.expect), withEnv });
	runner.describe(name, () => {
		for (const testCase of cases) runner.it(testCase.name, testCase.run, testCase.timeoutMs);
	});
}
