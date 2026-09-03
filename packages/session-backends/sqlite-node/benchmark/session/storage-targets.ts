import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { StorageFixture } from "@earendil-works/pi-agent-core/harness/session/testing";
import { createNodeSqliteFactory, SQLITE_STORAGE_VERSION, SqliteStorage, sql } from "../../src/index.ts";
import { applyInitialSchema } from "../../src/sqlite/migrations.ts";
import type { BenchmarkTarget } from "../../../../agent/benchmark/session/benchmark.ts";

const SESSION_ID = "session";
const NOW = 1_700_000_000_000;
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const storageBenchmarkTargets = [
	{
		name: "sqlite",
		async createFixture() {
			const db = await createNodeSqliteFactory().open(":memory:");
			try {
				db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
				await applyInitialSchema(db);
				sql`INSERT INTO sessions
					(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
					VALUES (${SESSION_ID}, ${NOW}, ${null}, ${SQLITE_STORAGE_VERSION}, ${null}, ${0}, ${JSON.stringify(EMPTY_USAGE)}, ${1})`.run(
					db,
				);
				const storage = new SqliteStorage(db, { sessionId: SESSION_ID, now: () => NOW });
				return {
					storage,
					async [Symbol.asyncDispose]() {
						try {
							await storage.close(BACKGROUND_CONTEXT);
						} finally {
							db.close();
						}
					},
				} satisfies StorageFixture;
			} catch (error) {
				db.close();
				throw error;
			}
		},
	},
] satisfies readonly BenchmarkTarget<StorageFixture>[];
