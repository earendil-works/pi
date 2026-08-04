import { join } from "node:path";
import type { SessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "@earendil-works/pi-agent-core/session/testing";
import { describe, it } from "vitest";
import { createNodeSqliteFactory, type SqliteSessionMetadata, SqliteSessionRepository } from "../src/index.ts";
import { createTempDir } from "./test-utils.ts";

function requireSqliteMetadata(metadata: SessionMetadata): SqliteSessionMetadata {
	const cwd = "cwd" in metadata ? metadata.cwd : undefined;
	if (typeof cwd !== "string") {
		throw new Error(`Expected SQLite metadata for session ${metadata.id}`);
	}
	const path = "path" in metadata ? metadata.path : undefined;
	if (typeof path !== "string") {
		throw new Error(`Expected SQLite metadata for session ${metadata.id}`);
	}
	return { ...metadata, cwd, path };
}

const conformance = createSessionBackendConformance(async () => {
	const root = createTempDir();
	const sqliteRepository = new SqliteSessionRepository({
		env: new NodeExecutionEnv({ cwd: root }),
		sqlite: createNodeSqliteFactory(),
		databasePath: join(root, "sessions.sqlite"),
	});
	const repository: SessionRepo = {
		create: (options = {}) => sqliteRepository.create({ ...options, cwd: root }),
		open: (metadata) => sqliteRepository.open(requireSqliteMetadata(metadata)),
		list: () => sqliteRepository.list(),
		delete: (metadata) => sqliteRepository.delete(requireSqliteMetadata(metadata)),
		fork: (source, options = {}) => sqliteRepository.fork(requireSqliteMetadata(source), { ...options, cwd: root }),
	};
	return {
		repository,
		async [Symbol.asyncDispose]() {
			await sqliteRepository.close();
		},
	} satisfies SessionBackendFixture;
});

describe("SqliteSessionRepository conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});
