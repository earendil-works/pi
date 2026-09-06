import { describe, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { type JsonlSessionMetadata, JsonlSessionRepo } from "../../src/harness/session/jsonl/index.ts";
import {
	type ConformanceCase,
	createSessionRepoForkBehaviorConformance,
	createSessionRepoForkSourceSnapshotConformance,
	createSessionRepoLifecycleConformance,
	createSessionRepoMessageConformance,
	createSessionRepoOwnershipConformance,
} from "../../src/harness/session/testing/index.ts";
import type { ForkOptions } from "../../src/harness/session/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;
const CONFORMANCE_CWD = "/workspace";

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

let jsonlRepo: JsonlSessionRepo;
async function createConformanceRepo() {
	const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
	jsonlRepo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
	return {
		create: (options: { id?: string; parentSessionId?: string }) =>
			jsonlRepo.create({ ...options, cwd: CONFORMANCE_CWD }, BACKGROUND_CONTEXT),
		open: (metadata: JsonlSessionMetadata) => jsonlRepo.open(metadata, BACKGROUND_CONTEXT),
		list: () => jsonlRepo.list({ cwd: CONFORMANCE_CWD }, BACKGROUND_CONTEXT),
		delete: (metadata: JsonlSessionMetadata) => jsonlRepo.delete(metadata, BACKGROUND_CONTEXT),
		fork: (source: JsonlSessionMetadata, options: ForkOptions) => jsonlRepo.fork(source, options, BACKGROUND_CONTEXT),
	};
}

registerConformance("JsonlSessionRepo conformance", [
	...createSessionRepoLifecycleConformance<JsonlSessionMetadata>(createConformanceRepo, () =>
		jsonlRepo.close(BACKGROUND_CONTEXT),
	),
	...createSessionRepoOwnershipConformance<JsonlSessionMetadata>(createConformanceRepo, () =>
		jsonlRepo.close(BACKGROUND_CONTEXT),
	),
	...createSessionRepoMessageConformance<JsonlSessionMetadata>(createConformanceRepo, () =>
		jsonlRepo.close(BACKGROUND_CONTEXT),
	),
	...createSessionRepoForkBehaviorConformance<JsonlSessionMetadata>(createConformanceRepo, () =>
		jsonlRepo.close(BACKGROUND_CONTEXT),
	),
	...createSessionRepoForkSourceSnapshotConformance<JsonlSessionMetadata>(createConformanceRepo, () =>
		jsonlRepo.close(BACKGROUND_CONTEXT),
	),
]);
