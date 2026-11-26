// The harness test files that take a SQLite storage, run on Durable's storage on Chord's store (`StoreStorage`, slice
// 6b): `../src/storage/sqlite/node.ts`'s opener is replaced by `test/store-storage-node.ts`; the files are unchanged.
// Four tests edit or read `SqliteStorage`'s own tables with raw SQL (`tasks`, `durable_metadata`) and are left out.

import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

const storeOpener = fileURLToPath(new URL("./test/store-storage-node.ts", import.meta.url));

export default mergeConfig(
	base,
	defineConfig({
		test: {
			testNamePattern:
				/^(?!.*(resumes a retry backoff after reopen|sleeps again for a retry stored as a running phase|polls a checkpoint stored without a thinking level|refuses to create the root of an empty storage))/,
			include: [
				"test/harness-after-run.test.ts",
				"test/harness-blocked.test.ts",
				"test/harness-compaction.test.ts",
				"test/harness-continue.test.ts",
				"test/harness-conversations.test.ts",
				"test/harness-generation-recovery.test.ts",
				"test/harness-inbox.test.ts",
				"test/harness-input-entries.test.ts",
				"test/harness-lifecycle.test.ts",
				"test/harness-nested-tools-restart.test.ts",
				"test/harness-nested-tools.test.ts",
				"test/harness-ownership.test.ts",
				"test/harness-read-only.test.ts",
				"test/harness-restart-failure.test.ts",
				"test/harness-scheduler-indexes.test.ts",
				"test/harness-scheduler-retention.test.ts",
				"test/harness-sleep.test.ts",
				"test/harness-structured.test.ts",
				"test/harness-submissions.test.ts",
				"test/harness-task-graph.test.ts",
				"test/harness-tasks-recovery.test.ts",
				"test/harness-tool-hooks.test.ts",
				"test/harness-tools-recovery.test.ts",
				"test/harness-turn-limit.test.ts",
				"test/harness-view.test.ts",
			],
		},
		resolve: { alias: [{ find: /^\.\.\/src\/storage\/sqlite\/node\.ts$/, replacement: storeOpener }] },
	}),
);
