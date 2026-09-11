import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type SessionRepo } from "@earendil-works/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepo } from "../../src/index.ts";
import type { BenchmarkTarget } from "../../../../agent/benchmark/session/benchmark.ts";

export interface SessionRepoBenchmarkFixture extends AsyncDisposable {
	readonly repo: SessionRepo;
}

const NOW = 1_700_000_000_000;

export const sessionRepoBenchmarkTargets = [
	{
		name: "sqlite",
		async createFixture() {
			const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-session-repo-benchmark-"));
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => NOW,
			});
			return {
				repo,
				async [Symbol.asyncDispose]() {
					await repo.close(BACKGROUND_CONTEXT);
					await rm(directory, { recursive: true, force: true });
				},
			};
		},
	},
] satisfies readonly BenchmarkTarget<SessionRepoBenchmarkFixture>[];
