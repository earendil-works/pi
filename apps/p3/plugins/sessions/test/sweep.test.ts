// What a session's workers keep, end to end (`testServer`: the real server and runner, workers as processes): a
// session removed (unlinked from its parent) loses its workers' directory once its worker stopped (`store.ts`'s
// `remove`), and a directory of a session with no row (a removal no runner was there for, older code's) is swept at the
// next start (`sweep.ts`), reported; and the sweep over a stand-in runner and store: each one deleted and reported as
// it goes, one that fails reported and holding up none of the others.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	type Reference,
	SessionWorker,
	until,
	Workspace,
	withGranted,
} from "@earendil-works/p3/v1";
import type { WorkerRunner } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { newSession, piOf } from "../../../test/support.ts";
import { eventually, within } from "../../../test/until.ts";
import type { SessionsStore } from "../contract.server.ts";
import { sweepGone } from "../sweep.ts";

let running: TestServer | undefined;

afterEach(async () => {
	await running?.close(context);
	running = undefined;
});

describe("what a session's workers keep", () => {
	it("goes with the session: its worker stops and its directory is deleted when the session is unlinked", async () => {
		running = await testServer({}, context);
		const t = running;
		const client = await t.client(context);
		const id = await newSession(client, "one", context);
		const dir = join(t.dataDir, "workers", id);
		await client.root(async (ctx) => {
			const worker = await ctx.get(SessionWorker, { session: id });
			await until(worker.session, (row) => row !== null, within("the worker", ctx));
		}, context);
		assert.ok(existsSync(dir), "a started worker keeps its store there");
		const pi = await piOf(client, context);
		await client.root(async (ctx) => {
			const workspace = withGranted(await ctx.get(Workspace, { workspace: pi }), "unlink")!;
			await workspace.unlink({ thing: id }, ctx);
		}, context);
		await eventually(
			() => existsSync(dir),
			(left) => !left,
			10_000,
		);
		assert.equal((await t.workers(context))[id], undefined, "no worker runs for it");
		assert.deepEqual(t.errors, []);
	});

	it("sweeps the directory of a session with no row at the next start, and keeps those of sessions there are", async () => {
		running = await testServer({}, context);
		const client = await running.client(context);
		const id = await newSession(client, "kept", context);
		await client.root(async (ctx) => {
			const worker = await ctx.get(SessionWorker, { session: id });
			await until(worker.session, (row) => row !== null, within("the worker", ctx));
		}, context);
		const orphan = join(running.dataDir, "workers", "a-session-gone");
		await mkdir(orphan, { recursive: true });
		await writeFile(join(orphan, "store.sqlite"), "left behind");
		running = await running.restart(context);
		const t = running;
		await eventually(
			() => existsSync(orphan),
			(left) => !left,
			10_000,
		);
		assert.ok(existsSync(join(t.dataDir, "workers", id)), "a session there is keeps its workers' directory");
		assert.deepEqual(t.errors, []);
	});
});

describe("the sweep of sessions gone", () => {
	// Astra, push 4 round 2: a removal that failed hid the ones done before it and starved the ones after it.
	it("deletes and reports each one as it goes; one that fails is reported and holds up none of the others", async () => {
		const removed: string[] = [];
		const runner = {
			stored: async () => ["one", "busy", "kept", "three"],
			remove: async (id: string) => {
				if (id === "busy") throw new Error("busy directory");
				removed.push(id);
			},
		} as unknown as WorkerRunner;
		// A stand-in of the store's one named query this reads: `kept` has a row.
		const store = {
			sessions: { one: { page: async ({ id }: { id: string }) => ({ items: id === "kept" ? [{ id }] : [] }) } },
		} as unknown as Reference<typeof SessionsStore>;
		const reported = mock.method(console, "error", () => {});
		try {
			await sweepGone(runner, store, context);
		} finally {
			reported.mock.restore();
		}
		assert.deepEqual(removed, ["one", "three"]);
		const lines = reported.mock.calls.map(({ arguments: [line] }) => String(line));
		assert.equal(lines.length, 3);
		assert.match(lines[0]!, /deleted the workers' data of a session gone: one/);
		assert.match(lines[1]!, /session busy, gone, is still there: .*busy directory/);
		assert.match(lines[2]!, /deleted the workers' data of a session gone: three/);
	});
});
