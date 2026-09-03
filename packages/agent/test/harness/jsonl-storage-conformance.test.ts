import { describe, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JSONL_FORMAT_VERSION, JsonlStorage } from "../../src/harness/session/jsonl/index.ts";
import {
	type ConformanceCase,
	createStorageConformance,
	type StorageFixture,
} from "../../src/harness/session/testing/index.ts";
import { createTempDir } from "./session-test-utils.ts";

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
	"JsonlStorage conformance",
	createStorageConformance(async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const storage = await JsonlStorage.create(
			{ fileSystem, path: "session.jsonl", now: () => NOW },
			{
				v: JSONL_FORMAT_VERSION,
				kind: "header",
				id: "session",
				storageVersion: 1,
				createdAt: NOW,
				cwd: "/workspace",
			},
			[],
			BACKGROUND_CONTEXT,
		);
		return {
			storage,
			[Symbol.asyncDispose]: () => storage.close(BACKGROUND_CONTEXT),
		} satisfies StorageFixture;
	}),
);
