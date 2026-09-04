import {
	type ConformanceCase,
	createSessionRepoConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { describe, it } from "vitest";
import { DurableSqliteSessionRepo } from "../src/index.ts";
import { createMemoryDurableSqliteStorage } from "./memory-durable-sql.ts";

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
	"DurableSqliteSessionRepo conformance",
	createSessionRepoConformance(
		async () =>
			new DurableSqliteSessionRepo({
				storage: createMemoryDurableSqliteStorage(),
				now: () => NOW,
			}),
	),
);
