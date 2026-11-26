// The sessions plugin end to end (`testServer`: the real server, workers as processes, clients over `/chord`): no
// worker starts for a person outside a session; a member's session objects, on the server and on the worker, are
// denied the moment they are removed; a reload of the plugin while a person's list and object are held; the waker
// skips archived sessions and starts at most four workers at once.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type Member,
	type P3Principal,
	type Reference,
	SessionInfo,
	SessionsList,
	SessionWorker,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { eventually, within } from "../../../test/until.ts";

let running: TestServer | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	await running?.close(context);
	running = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Runs `fn` on `t`'s server as the server, with the sessions store (apps' server code). */
function asServer<T>(
	t: TestServer,
	fn: (ctx: Ctx<P3Principal>, store: Reference<typeof SessionsStore>) => Promise<T>,
): Promise<T> {
	return t.host.root(async (ctx) => fn(ctx, await ctx.get(SessionsStore, {})), context);
}

/** Person `name` made on `t`: their principal. */
async function person(t: TestServer, name: string): Promise<Extract<P3Principal, { kind: "person" }>> {
	const id = await t.host.root(async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name }, ctx), context);
	return { kind: "person", id, name };
}

/** A coding session on `t` with `members`, working in its own folder; its id. */
function session(t: TestServer, members: Member[] = []): Promise<string> {
	return asServer(t, (ctx, store) => store.create({ app: "coding", title: "s", members }, ctx));
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("persons and session workers", () => {
	it("starts no worker for a person outside a session", async () => {
		const t = await testServer({}, context);
		running = t;
		const ann = await person(t, "Ann");
		const id = await session(t);
		const client = await t.client(context, ann);
		await refused(client.get(SessionWorker, { session: id }, context, { readyTimeout: 1000 }));
		await refused(client.get(SessionInfo, { session: id }, context, { readyTimeout: 1000 }));
		assert.deepEqual(await t.workers(context), {});
	});

	it("denies a member's session objects on the server and the worker the moment they are removed", async () => {
		const t = await testServer({}, context);
		running = t;
		const ann = await person(t, "Ann");
		const id = await session(t, [{ kind: "person", id: ann.id, access: "read" }]);
		const client = await t.client(context, ann);
		const worker = await client.get(SessionWorker, { session: id }, context);
		const info = await client.get(SessionInfo, { session: id }, context);
		assert.equal(worker.state.value.kind, "live");
		await until(worker.session, (row) => row?.id === id, within("the worker's row", context));
		assert.deepEqual([info.access.value, (await t.workers(context))[id]?.status], ["read", "running"]);
		await asServer(t, (ctx, store) =>
			store.removeMember({ session: id, party: { kind: "person", id: ann.id } }, ctx),
		);
		const denied = (state: { readonly kind: string; readonly cause?: { readonly kind: string } }) =>
			state.kind === "failed" && state.cause?.kind === "denied";
		await until(worker.state, denied, within("the worker's object denied", context));
		await until(info.state, denied, within("the info denied", context));
	});
});

describe("a reload of the sessions plugin", () => {
	it("keeps a person's list and their session's object going", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-sessions-reload-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), root, { recursive: true });
		const t = await testServer({ builtIn: root }, context);
		running = t;
		const ann = await person(t, "Ann");
		const id = await session(t, [{ kind: "person", id: ann.id, access: "write" }]);
		const client = await t.client(context, ann);
		const list = await client.get(SessionsList, { app: "coding", set: "active", view: "v" }, context);
		const info = await client.get(SessionInfo, { session: id }, context);
		assert.deepEqual(
			list.list.value.rows.map((row) => row.id),
			[id],
		);
		// A real edit of the plugin's server code, applied as `p3 apply` does once the watcher saw it.
		const file = join(root, "sessions", "server.ts");
		await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
		await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
		const applied = await t.apply(context);
		assert.equal(applied.stopped, undefined);
		const second = await session(t, [{ kind: "person", id: ann.id, access: "read" }]);
		await until(
			list.list,
			(value) => value.rows.some((row) => row.id === second),
			within("the new session in the list", context),
		);
		await asServer(t, (ctx, store) => store.rename({ session: id, title: "renamed" }, ctx));
		await until(info.session, (row) => row.title === "renamed", within("the renamed session", context));
		assert.equal(info.access.value, "write");
		assert.deepEqual(t.errors, []);
	});
});

describe("the waker", () => {
	it("starts the workers of working sessions after a restart, at most four at once, and no archived one", async () => {
		// Workers that stay up while the test reads their state (nothing here keeps them busy).
		const t = await testServer({ idleMs: 60_000 }, context);
		running = t;
		const working: string[] = [];
		for (let i = 0; i < 6; i++) working.push(await session(t));
		const archived = await session(t);
		await asServer(t, async (ctx, store) => {
			for (const id of [...working, archived]) await store.report({ session: id, state: "working" }, ctx);
			await store.archive({ session: archived }, ctx);
		});
		// A wrap that holds each start a moment and counts the starts under way (this process: globalThis).
		await writeFile(join(t.userRoot, "counting.server.ts"), COUNTING);
		running = await t.restart(context);
		const restarted = running;
		await eventually(
			() => restarted.workers(context),
			(workers) => working.every((id) => workers[id]?.status === "running"),
		);
		assert.deepEqual(restarted.errors, []);
		const counted = (globalThis as { p3WakerTest?: { most: number; started: string[] } }).p3WakerTest!;
		assert.ok(counted.most <= 4 && counted.most > 1, `at most four at once: ${counted.most}`);
		assert.deepEqual(new Set(counted.started), new Set(working));
		assert.equal((await restarted.workers(context))[archived], undefined);
	});
});

/** A single-file server plugin: a wrap that delays each start by 200 ms and records the most under way at once. */
const COUNTING = `import { defineFacet } from "@earendil-works/p3/v1";
import { WorkerRunnerWraps } from "@earendil-works/p3/v1/server";
const counted = (globalThis.p3WakerTest = { now: 0, most: 0, started: [] });
export default defineFacet((_host, self) =>
	self.contribute(WorkerRunnerWraps, (inner) => ({
		start: async (address, ctx) => {
			counted.started.push(address.params.id);
			counted.most = Math.max(counted.most, ++counted.now);
			try {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return await inner.start(address, ctx);
			} finally {
				counted.now--;
			}
		},
		stop: (id) => inner.stop(id),
		retry: (id) => inner.retry(id),
		state: () => inner.state(),
		pids: () => inner.pids(),
		reload: (built, ctx) => inner.reload(built, ctx),
	})),
);
`;
