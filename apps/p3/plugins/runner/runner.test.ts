// The local runner against real processes: closing it (its plugin's object ends: a reload of the runner plugin, the
// server's close) stops every worker it runs, cleanly.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ChordStore, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { Session } from "@earendil-works/p3/v1";
import type { ServerRuntime } from "@earendil-works/p3/v1/server";
import { WORKER } from "../../src/install.ts";
import { eventually } from "../../test/support.ts";
import { LocalRunner } from "./local-runner.ts";

describe("the local runner", () => {
	it("stops every worker it runs when it closes, and none of them counts as failed", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "p3-runner-"));
		// `openStore` makes the one kind of store there is.
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
		const runtime = {
			dataDir,
			store,
			worker: WORKER,
			workerIdleMs: 60_000,
			workerScripts: async () => [],
		} as Partial<ServerRuntime> as ServerRuntime;
		const runner = new LocalRunner(() => runtime);
		try {
			for (const id of ["a", "b"]) await runner.start(Session({ id }), context);
			const running = await eventually(
				async () => runner.state(),
				(state) =>
					Object.values(state).every((each) => each.status === "running") && Object.keys(state).length === 2,
			);
			const pids = Object.values(running).map((each) => ("pid" in each ? each.pid : -1));
			await runner.close();
			assert.deepEqual(runner.state(), {});
			for (const pid of pids) assert.throws(() => process.kill(pid, 0), "the worker process is gone");
		} finally {
			await runner.close();
			await store.close(context);
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
