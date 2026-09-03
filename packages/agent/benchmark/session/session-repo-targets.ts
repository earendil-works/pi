import { MemorySessionRepo } from "../../src/harness/session/index.ts";
import type { SessionRepo } from "../../src/harness/session/types.ts";
import type { BenchmarkTarget } from "./benchmark.ts";

export interface SessionRepoBenchmarkFixture extends AsyncDisposable {
	readonly repo: SessionRepo;
}

const NOW = 1_700_000_000_000;

export const sessionRepoBenchmarkTargets = [
	{
		name: "memory",
		createFixture() {
			const repo = new MemorySessionRepo({ now: () => NOW });
			return Promise.resolve({
				repo,
				[Symbol.asyncDispose]: () => repo.close(),
			});
		},
	},
] satisfies readonly BenchmarkTarget<SessionRepoBenchmarkFixture>[];
