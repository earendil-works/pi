// The harness end to end (`testServer`: the real server, workers as processes, the faux login plugin under test): a
// session with a faux login and the coding tools answers through its transcript, its tool running in the session's
// folder; its state reaches the owner's list (working, then settled); the worker stays alive while working with no
// holder; a server restart mid-call resumes the run; an archived session's cut-off run schedules nothing; a row left
// `working` with nothing to do (a crash before Durable took the input, or before the settled report) is settled by
// the waker's start; a reload of the harness plugin mid-call finishes the run.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	type Host,
	type P3Principal,
	type SessionState,
	SessionsList,
	THIS_DEVICE,
	Transcript,
	until,
} from "@earendil-works/p3/v1";
import { SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestServer, type TestServerOptions, testServer } from "@earendil-works/p3/v1/testing";
import { type FauxRequest, FauxRequests, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { eventually, within } from "../../../test/until.ts";

/** The faux login plugin, a plugin under test of a root of its own. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/** A bash call that marks it started and waits for the folder's `gate`, then prints the folder. */
const GATED = "touch started; until [ -e gate ]; do sleep 0.02; done; pwd";

let running: TestServer | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	await running?.close(context);
	running = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A temporary directory, removed after the case. */
async function directory(prefix: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A coding session on `t` in `folder` with a faux login answering from `script` and the coding tools; its id. */
function session(t: TestServer, folder: string, script: Step[]): Promise<string> {
	return t.host.root(async (ctx) => {
		const store = await ctx.get(SessionsStore, {});
		return store.create(
			{
				app: "coding",
				title: "s",
				location: { environment: THIS_DEVICE, folder },
				things: [
					{ kind: "faux.login", options: { provider: "faux", script, tool: false } },
					{ kind: "tools.coding", options: { shell: true } },
				],
			},
			ctx,
		);
	}, context);
}

/** Sends `text` to `session`'s transcript as `client`'s owner, holding nothing afterwards. */
async function send(client: Host<P3Principal>, session: string, text: string): Promise<void> {
	await client.root(async (ctx) => {
		const transcript = await ctx.get(Transcript, { session });
		assert.equal(transcript.variant, "writer");
		if (transcript.variant === "writer") await transcript.send({ text, requestId: text }, ctx);
	}, context);
}

/** Waits until `session`'s row in the owner's list is in `state`. */
async function reaches(client: Host<P3Principal>, session: string, state: SessionState, ms = 10_000): Promise<void> {
	await client.root(async (ctx) => {
		const list = await ctx.get(SessionsList, { app: "coding", set: "active", view: `state-${state}` });
		await until(
			list.list,
			(value) => value.rows.find((row) => row.id === session)?.state === state,
			within(`the row ${state}`, ctx, ms),
		);
	}, context);
}

/** What the session's faux login received on its current worker. */
function requests(client: Host<P3Principal>, session: string): Promise<FauxRequest[]> {
	return client.root(async (ctx) => (await ctx.get(FauxRequests, { session })).requests.value, context);
}

/** `t` restarted: the new server is the case's. */
async function restart(t: TestServer): Promise<TestServer> {
	running = await t.restart(context);
	return running;
}

/** A test server with the faux login under test. */
async function start(options: TestServerOptions = {}): Promise<TestServer> {
	running = await testServer({ plugins: [FAUX], ...options }, context);
	return running;
}

describe("the harness end to end", () => {
	it("answers through the transcript, its tool in the folder, working then settled, alive without a holder", async () => {
		const folder = await directory("p3-harness-e2e-");
		const t = await start();
		const id = await session(t, folder, [
			{ when: "@go", reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command: GATED }) }] },
			{ when: folder, reply: [{ kind: "text", text: "done" }] },
		]);
		const client = await t.client(context);
		await send(client, id, "@go");
		await reaches(client, id, "working");
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		// Nothing holds the session now; its idle time passes three times over.
		await new Promise((resolve) => setTimeout(resolve, t.idleMs * 3));
		assert.equal((await t.workers(context))[id]?.status, "running", "a working run keeps its worker");
		await writeFile(join(folder, "gate"), "");
		await reaches(client, id, "settled");
		const seen = await requests(client, id);
		assert.equal(seen.length, 2);
		assert.ok(seen[1]?.last.includes(folder), "the tool ran in the session's folder");
		assert.deepEqual(t.errors, []);
	});

	it("resumes a run cut off by a server restart", async () => {
		const folder = await directory("p3-harness-e2e-");
		const first = await start();
		const id = await session(first, folder, [
			{ when: "@go", reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command: GATED }) }] },
			{ when: "", reply: [{ kind: "text", text: "resumed" }] },
		]);
		await send(await first.client(context), id, "@go");
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		const t = await restart(first);
		// The waker starts the working session's worker; the interrupted call's result goes to the model.
		const client = await t.client(context);
		await reaches(client, id, "settled", 20_000);
		const seen = await requests(client, id);
		assert.equal(seen.length, 1, "one request after the restart");
		assert.deepEqual(t.errors, []);
	});

	it("schedules nothing for an archived session whose run was cut off", async () => {
		const folder = await directory("p3-harness-e2e-");
		const first = await start();
		const id = await session(first, folder, [
			{ when: "@go", reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command: GATED }) }] },
			{ when: "", reply: [{ kind: "text", text: "ran" }] },
		]);
		await send(await first.client(context), id, "@go");
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		await first.host.root(async (ctx) => (await ctx.get(SessionsStore, {})).archive({ session: id }, ctx), context);
		const t = await restart(first);
		const client = await t.client(context);
		await client.root(async (ctx) => {
			const transcript = await ctx.get(Transcript, { session: id });
			await until(transcript.view, (view) => view !== null, within("the transcript", ctx));
			// Time for a resumed run to ask the model, had it resumed.
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.deepEqual((await ctx.get(FauxRequests, { session: id })).requests.value, []);
		}, context);
	});

	it("settles a row left working with nothing to do, before Durable took an input or after it answered", async () => {
		const folder = await directory("p3-harness-e2e-");
		const first = await start();
		const before = await session(first, folder, []);
		const after = await session(first, folder, [{ when: "", reply: [{ kind: "text", text: "ok" }] }]);
		const firstClient = await first.client(context);
		await send(firstClient, after, "hello");
		await reaches(firstClient, after, "settled");
		// A crash after the report of `working` and before Durable's commit (`before`), and one after Durable's commit
		// of the answer and before the report of `settled` (`after`), leave each row `working`.
		await first.host.root(async (ctx) => {
			const store = await ctx.get(SessionsStore, {});
			for (const session of [before, after]) await store.report({ session, state: "working" }, ctx);
		}, context);
		const t = await restart(first);
		const client = await t.client(context);
		await reaches(client, before, "settled", 20_000);
		await reaches(client, after, "settled", 20_000);
	});

	it("finishes a run when the harness plugin is reloaded mid-call", async () => {
		const folder = await directory("p3-harness-e2e-");
		const built = join(await directory("p3-harness-reload-"), "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), built, { recursive: true });
		const t = await start({ builtIn: built });
		const id = await session(t, folder, [
			{ when: "@go", reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command: GATED }) }] },
			{ when: "", reply: [{ kind: "text", text: "after the reload" }] },
		]);
		const client = await t.client(context);
		const transcript = await client.get(Transcript, { session: id }, context);
		assert.equal(transcript.variant, "writer");
		if (transcript.variant !== "writer") return;
		await transcript.send({ text: "@go", requestId: "go" }, context);
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		const file = join(built, "harness", "worker.ts");
		await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
		await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
		await t.apply(context);
		await writeFile(join(folder, "gate"), "");
		await reaches(client, id, "settled", 20_000);
		// The held transcript follows the next harness and shows the answer.
		await until(
			transcript.view,
			(view) => JSON.stringify(view).includes("after the reload"),
			within("the answer in the held transcript", context, 10_000),
		);
		assert.deepEqual(t.errors, []);
	});
});
