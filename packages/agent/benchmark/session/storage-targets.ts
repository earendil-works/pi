import { MemoryStorage } from "../../src/harness/session/memory.ts";
import type { StorageFixture } from "../../src/harness/session/testing/index.ts";
import type { BenchmarkTarget } from "./benchmark.ts";

const NOW = 1_700_000_000_000;

export const storageBenchmarkTargets = [
	{
		name: "memory",
		createFixture() {
			const storage = new MemoryStorage({ now: () => NOW });
			return Promise.resolve({
				storage,
				[Symbol.asyncDispose]: () => storage.close(),
			});
		},
	},
] satisfies readonly BenchmarkTarget<StorageFixture>[];
