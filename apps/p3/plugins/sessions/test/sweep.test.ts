// What a session's workers keep, end to end (`testServer`: the real server and runner, workers as processes): a
// session removed (unlinked from its parent) loses its workers' directory once its worker stopped (`store.ts`'s
// `remove`), and a directory of a session with no row (a removal no runner was there for, older code's) is swept at the
// next start (`sweep.ts`), reported.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, SessionWorker, until, Workspace, withGranted } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { newSession, piOf } from "../../../test/support.ts";
import { eventually, within } from "../../../test/until.ts";

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
