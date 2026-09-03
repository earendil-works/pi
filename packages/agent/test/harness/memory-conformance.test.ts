import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { MemorySessionRepo } from "../../src/harness/session/index.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import {
	type ConformanceCase,
	createSessionRepoConformance,
	createStorageConformance,
	type StorageFixture,
} from "../../src/harness/session/testing/index.ts";
import * as storedValues from "../../src/harness/session/values.ts";

const NOW = 1_700_000_000_000;

function registerConformance(name: string, cases: readonly ConformanceCase[]): void {
	describe(name, () => {
		for (const group of new Set(cases.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of cases.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

registerConformance(
	"MemoryStorage conformance",
	createStorageConformance(() => {
		const storage = new MemoryStorage({ now: () => NOW });
		return Promise.resolve<StorageFixture>({
			storage,
			[Symbol.asyncDispose]: () => storage.close(BACKGROUND_CONTEXT),
		});
	}),
);

describe("MemoryStorage commit statistics", () => {
	it("includes historical totals in the first commit after session reopen", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const session = await repo.create({}, BACKGROUND_CONTEXT);
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		try {
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({
								id: "history",
								parentId: null,
								type: "message",
								message: { role: "user", content: "history", timestamp: NOW },
							}),
							sessionWrites.insertUsage({ id: "usage", usage, adjustment: false }),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			await session.close(BACKGROUND_CONTEXT);
			const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
			const result = await reopened.mutate(
				(mutator) =>
					mutator.commit([storedValues.setValue(storedValues.sessionName, "reopened")], BACKGROUND_CONTEXT),
				BACKGROUND_CONTEXT,
			);
			expect(result.stats).toEqual({ messageCount: 1, usage });
			expect(result.stats).toEqual(await reopened.getStats(BACKGROUND_CONTEXT));
			await reopened.close(BACKGROUND_CONTEXT);
		} finally {
			await repo.close(BACKGROUND_CONTEXT);
		}
	});
});

let memoryRepo: MemorySessionRepo;
registerConformance(
	"MemorySessionRepo conformance",
	createSessionRepoConformance(
		() => {
			memoryRepo = new MemorySessionRepo({ now: () => NOW });
			return Promise.resolve(memoryRepo);
		},
		() => memoryRepo.close(BACKGROUND_CONTEXT),
	),
);
