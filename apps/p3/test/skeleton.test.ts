// The skeleton end to end (ERNDL-954): the real server in this process, its session workers as real processes, a
// client signed in as the owner over WebSocket. One case per rule of the base, the runner and the sessions plugin.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { remote, Session, str } from "@earendil-works/p3/v1";
import { WorkerRunners } from "@earendil-works/p3/v1/server";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { SignIns } from "../plugins/sign-in/contract.ts";
import { ask, type ServerAnswer, serverSocket } from "../src/local-socket.ts";
import { Probe } from "./plugins/probe/contract.ts";
import { alive, eventually, IDLE_MS, type TestServer, testServer } from "./support.ts";
import { until } from "./until.ts";

let running: TestServer | undefined;

/** The contract of the plugin the apply test writes (`versioned`): its version, on a session's worker. */
const Versioned = remote("versioned.versioned", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { version: str() } } },
});

/** The source of a single-file worker plugin serving `Versioned` with `version`. */
function versioned(version: string): string {
	return `import { constant, defineFacet, remote, Session, str } from "@earendil-works/p3/v1";
const Versioned = remote("versioned.versioned", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { version: str() } } },
});
export default defineFacet((host) => {
	host.serve(Versioned, () => ({ variant: "owner", members: { version: constant(${JSON.stringify(version)}) } }));
});
`;
}

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** A server with one session; its id. */
async function withSession(): Promise<{ readonly t: TestServer; readonly id: string }> {
	running = await testServer();
	const client = await running.client();
	const sessions = await client.get(Sessions, {}, context);
	return { t: running, id: await sessions.create({ title: "one" }, context) };
}

/** The probe on session `id`'s worker, held by a new owner client until `release`. */
async function probe(t: TestServer, id: string) {
	const client = await t.client();
	const held = await client.get(Probe, { session: id }, context);
	assert.equal(held.variant, "owner");
	return held as Extract<typeof held, { readonly variant: "owner" }>;
}

describe("session workers", () => {
	it("a worker starts on the first hold, as a process of its own, and follows its session's row", async () => {
		const { t, id } = await withSession();
		const worker = await (await t.client()).get(SessionWorker, { session: id }, context);
		assert.equal(worker.variant, "owner");
		const pid = (await probe(t, id)).pid.value;
		assert.notEqual(pid, process.pid);
		assert.ok(alive(pid));
		const sessions = await (await t.client()).get(Sessions, {}, context);
		await sessions.rename({ id, title: "two" }, context);
		if (worker.variant !== "owner") return;
		await until(worker.session, (row) => row?.title === "two", context);
	});

	it("a worker nobody holds stops itself after its idle time, cleanly", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		const pid = held.pid.value;
		held.release();
		await eventually(
			async () => alive(pid),
			(lives) => !lives,
		);
		// A clean exit: the session is not failed, and the next hold starts a new worker.
		assert.deepEqual(await t.workers(), {});
		assert.notEqual((await probe(t, id)).pid.value, pid);
	});

	it("a worker with work in `WorkerBusy` stays alive unheld, and stops once it is done", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		const pid = held.pid.value;
		await held.busy(1, context);
		held.release();
		await sleep(IDLE_MS * 4);
		assert.ok(alive(pid));
		const again = await probe(t, id);
		await again.busy(0, context);
		again.release();
		await eventually(
			async () => alive(pid),
			(lives) => !lives,
		);
	});

	it("a worker that crashes fails its session until retry", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		const pid = held.pid.value;
		await held.crash(context);
		await eventually(
			() => t.workers(),
			(workers) => workers[id]?.status === "failed",
		);
		assert.ok(!alive(pid));
		const client = await t.client();
		await assert.rejects(client.get(Probe, { session: id }, context, { readyTimeout: 1000 }));
		(await t.server.runtime.host.registry(WorkerRunners, context)).value?.retry(id);
		assert.notEqual((await probe(t, id)).pid.value, pid);
	});

	it("a working session's worker starts again after a server restart, unasked", async () => {
		const { t, id } = await withSession();
		const held = await probe(t, id);
		await t.report(id, "working");
		await held.busy(1, context);
		running = await t.restart();
		const restarted = running;
		await eventually(
			() => restarted.workers(),
			(workers) => workers[id]?.status === "running",
		);
	});

	it("an apply ships a changed worker plugin to a running worker", async () => {
		const { t, id } = await withSession();
		const file = join(t.plugins, "versioned.worker.ts");
		await writeFile(file, versioned("1"));
		const client = await t.client();
		// The watcher sees the new file a moment after it is written: applied until the plugin is there.
		const held = await eventually(async () => {
			await t.server.runtime.apply(context);
			return client.get(Versioned, { session: id }, context, { readyTimeout: 500 });
		});
		assert.equal(held.variant, "owner");
		if (held.variant !== "owner") return;
		assert.equal(held.version.value, "1");
		await writeFile(file, versioned("2"));
		await eventually(
			async () => {
				const result = await t.server.runtime.apply(context);
				assert.equal(result.stopped, undefined);
				return held.version.value;
			},
			(version) => version === "2",
		);
	});
});

describe("the server", () => {
	it("closes once when asked twice at once, and frees its data directory for the next server", async () => {
		const first = await testServer();
		await Promise.all([first.server.close(context), first.server.close(context)]);
		running = await testServer({ dataDir: first.dataDir });
		assert.notEqual(running.server.port, 0);
	});
});

describe("sign-in", () => {
	it("the owner link the command asks for over the data directory's socket signs a browser in once", async () => {
		running = await testServer();
		const base = `http://127.0.0.1:${running.server.port}`;
		const answer = (await ask(serverSocket(running.dataDir), {
			kind: "command",
			name: "owner-link",
		})) as ServerAnswer;
		assert.equal(answer.kind, "answer");
		const link = answer.kind === "answer" ? String(answer.value) : "";
		const once = new URL(link).hash.slice(1);
		const post = (body: unknown) =>
			fetch(`${base}/_p3/owner`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const signedIn = await post({ token: once });
		assert.equal(signedIn.status, 200);
		const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
		assert.ok(cookie !== undefined);
		const withCookie = await fetch(`${base}/_p3/owner/link`, { method: "POST", headers: { cookie } });
		assert.equal(withCookie.status, 200);
		assert.equal((await post({ token: once })).status, 403);
		assert.equal((await fetch(`${base}/_p3/owner/link`, { method: "POST" })).status, 401);
	});

	it("the owner's control routes refuse a person's sign-in", async () => {
		running = await testServer();
		const base = `http://127.0.0.1:${running.server.port}`;
		const person = { kind: "person", id: "ann", name: "Ann" } as const;
		const { token } = await running.server.runtime.host.root(
			async (ctx) => (await ctx.get(SignIns, {})).issue({ principal: person, label: "ann", kind: "device" }, ctx),
			context,
		);
		for (const path of ["/_p3/stop", "/_p3/apply", "/_p3/owner/link"]) {
			const answer = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			});
			assert.equal(answer.status, 403, path);
		}
	});
});
