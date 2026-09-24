import { createExpectAssertions, type ExpectLike } from "./assertions.ts";
import { createStorageConformance } from "./storage-conformance.ts";
import type { StorageConformanceProvider } from "./types.ts";

export interface StorageConformanceRunner {
	readonly describe: (name: string, suite: () => void) => unknown;
	readonly expect: ExpectLike;
	readonly it: (name: string, test: () => Promise<void>) => unknown;
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
