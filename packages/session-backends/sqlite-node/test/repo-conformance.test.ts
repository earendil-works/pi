import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConformanceCase,
	createSessionRepoConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { describe, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepo } from "../src/index.ts";

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

let currentDirectory: string | undefined;
let currentSharedDirectory: string | undefined;

async function createConformanceRepo() {
	currentDirectory = await mkdtemp(join(tmpdir(), "pi-sqlite-session-repo-conformance-"));
	return new SqliteSessionRepo({
		directory: currentDirectory,
		databaseFactory: createNodeSqliteFactory(),
		now: () => NOW,
	});
}

async function createSharedContainerConformanceRepo() {
	currentSharedDirectory = await mkdtemp(join(tmpdir(), "pi-sqlite-session-repo-shared-conformance-"));
	return new SqliteSessionRepo({
		directory: currentSharedDirectory,
		databasePath: join(currentSharedDirectory, "sessions.sqlite"),
		databaseFactory: createNodeSqliteFactory(),
		now: () => NOW,
	});
}

async function cleanupConformanceRepo() {
	if (currentDirectory === undefined) return;
	await rm(currentDirectory, { recursive: true, force: true });
	currentDirectory = undefined;
}

async function cleanupSharedContainerConformanceRepo() {
	if (currentSharedDirectory === undefined) return;
	await rm(currentSharedDirectory, { recursive: true, force: true });
	currentSharedDirectory = undefined;
}

registerConformance(
	"SqliteSessionRepo conformance",
	createSessionRepoConformance(createConformanceRepo, cleanupConformanceRepo),
);

registerConformance(
	"SqliteSessionRepo shared-container conformance",
	createSessionRepoConformance(createSharedContainerConformanceRepo, cleanupSharedContainerConformanceRepo),
);
