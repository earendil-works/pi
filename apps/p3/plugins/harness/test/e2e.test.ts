// The harness end to end (`testServer`: the real server, workers as processes, the faux login plugin under test): a
// session made in Pi, so it has Pi's coding tools, with a faux login made in it, answers through its transcript, its
// tool running in the session's folder; its state reaches its row (working, then settled); the worker stays alive while working with no
// holder; a server restart mid-call resumes the run; an archived session's cut-off run schedules nothing; a row left
// `working` with nothing to do (a crash before Durable took the input, or before the settled report) is settled by
// the waker's start; a reload of the harness plugin mid-call finishes the run; Bash withheld from the agents in one
// session is gone from the agent's next request there, and only there (ERNDL-704 test 5); a conversation moved by the
// owner runs its next tool there (ERNDL-704 test 8).

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
	SessionObject,
	type SessionState,
	Transcript,
	until,
	withGranted,
} from "@earendil-works/p3/v1";
import { SessionsStore } from "@earendil-works/p3/v1/server";
import { ownerClient, type TestServer, type TestServerOptions, testServer } from "@earendil-works/p3/v1/testing";
import { type FauxRequest, FauxRequests, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { newSession, scriptFaux, scriptFauxAs } from "../../../test/support.ts";
import { eventually, within } from "../../../test/until.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import { CodingToolsKind } from "../../tools/kind.ts";

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

/**
 * A session on `t` in `folder`, made in Pi by the owner (Pi's coding tools reach it), with a faux login scripted here
 * with `script`; its id.
 */
async function session(t: TestServer, folder: string, script: Step[]): Promise<string> {
	const id = await newSession(await t.client(context), "s", context, { folder });
	// The session's faux login, made in its workspace by the server, answering from `script`.
	await scriptFaux(t.host, id, script, context);
	return id;
}

/** Sends `text` to `session`'s transcript as `client`'s owner, holding nothing afterwards. */
async function send(client: Host<P3Principal>, session: string, text: string): Promise<void> {
	await client.root(async (ctx) => {
		const transcript = withGranted(await ctx.get(Transcript, { session }), "send")!;
		await transcript.send({ text, requestId: text }, ctx);
	}, context);
}

/** Waits until `session`'s row (as the owner holds the session) is in `state`. */
async function reaches(client: Host<P3Principal>, session: string, state: SessionState, ms = 10_000): Promise<void> {
	await client.root(async (ctx) => {
		const held = await ctx.get(SessionObject, { workspace: session, thing: session });
		await until(held.row, (row) => row.state === state, within(`the row ${state}`, ctx, ms));
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

	// ERNDL-704 test 8 (decision 24): the owner moves the main conversation; its next tool call runs there.
	it("runs a conversation's next tool where the owner moved it, on a machine the agents have Work on", async () => {
		const [folder, moved] = [await directory("p3-harness-e2e-"), await directory("p3-harness-moved-")];
		const t = await start();
		const pwd = { kind: "tool", name: "bash", args: JSON.stringify({ command: "pwd" }) } as const;
		const id = await session(t, folder, [
			{ when: "@where", reply: [pwd] },
			{ when: "", reply: [{ kind: "text", text: "done" }] },
		]);
		const client = await t.client(context);
		const machine = await t.host.root(
			async (ctx) => until((await ctx.get(OneThing, { kind: MACHINE_KIND })).thing, (thing) => thing !== "", ctx),
			context,
		);
		await client.root(async (ctx) => {
			const held = withGranted(await ctx.get(SessionObject, { workspace: id, thing: id }), "moveLocation")!;
			// The main conversation is Durable's root, id 1.
			await held.moveLocation({ conversation: "1", location: { machine, folder: moved } }, ctx);
		}, context);
		await send(client, id, "@where");
		await reaches(client, id, "settled");
		const seen = await requests(client, id);
		assert.ok(seen.at(-1)?.last.includes(moved), `the tool ran in the moved folder: ${seen.at(-1)?.last}`);
		assert.deepEqual(t.errors, []);
	});

	// ERNDL-704's end to end (Opus, round 1): a second person with Read only reads the answer and cannot send.
	it("lets a person with Read only read a session's answer, without the send", async () => {
		const folder = await directory("p3-harness-e2e-");
		const t = await start();
		const id = await session(t, folder, [{ when: "", reply: [{ kind: "text", text: "hello there" }] }]);
		const by = { kind: "plugin", plugin: "test" } as const;
		const ann = await t.host.root(async (ctx) => {
			const things = await ctx.get(ThingsStore, {});
			const person = await things.createPerson({ name: "Ann", madeBy: by }, ctx);
			const pi = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
			await things.putParty({ workspace: pi, party: { kind: "person", person }, source: by }, ctx);
			// The session's grant for everyone here is Read and Send: Ann's Send is withheld on the session itself.
			const grant = {
				workspace: id,
				thing: id,
				party: { kind: "person", person },
				tick: "send",
				gives: false,
			} as const;
			await things.setGrants({ source: by, grants: [grant] }, ctx);
			return person;
		}, context);
		const owner = await t.client(context);
		await send(owner, id, "hi");
		await reaches(owner, id, "settled");
		const annClient = await t.client(context, { kind: "person", id: ann, name: "Ann" });
		const held = await annClient.get(Transcript, { session: id }, context);
		assert.equal(held.send, undefined);
		const reader = withGranted(held, "view", "entries")!;
		await until(
			reader.view,
			(view) => JSON.stringify(view).includes("hello there"),
			within("the answer, read by Ann", context),
		);
		assert.deepEqual(t.errors, []);
	});

	// ERNDL-704 test 5 (scenario 4): Bash taken from the agents in one session, the coding tools staying Pi's.
	it("offers bash no more in a session where it is withheld from the agents, and still in another", async () => {
		const folder = await directory("p3-harness-e2e-");
		const t = await start();
		const script: Step[] = [{ when: "", reply: [{ kind: "text", text: "ok" }] }];
		const one = await session(t, folder, script);
		const other = await session(t, folder, script);
		const client = await t.client(context);
		await send(client, one, "first");
		await reaches(client, one, "settled");
		assert.ok((await requests(client, one))[0]?.tools.includes("bash"));
		await t.host.root(async (ctx) => {
			const tools = (await ctx.get(OneThing, { kind: CodingToolsKind.name })).thing.value;
			const grant = { workspace: one, thing: tools, party: { kind: "agents" }, tick: "bash", gives: false } as const;
			await (await ctx.get(ThingsStore, {})).setGrants(
				{ source: { kind: "plugin", plugin: "test" }, grants: [grant] },
				ctx,
			);
		}, context);
		await send(client, one, "second");
		await reaches(client, one, "settled");
		const seen = await requests(client, one);
		assert.equal(seen.length, 2);
		assert.equal(seen[1]?.tools.includes("bash"), false);
		assert.ok(seen[1]?.tools.includes("read"));
		await send(client, other, "there");
		await reaches(client, other, "settled");
		assert.ok((await requests(client, other))[0]?.tools.includes("bash"));
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

	// Astra, round 2 (must 1): an archive stops the run under way (decision 122).
	it("makes no next model call once the session is archived while a tool runs", async () => {
		const folder = await directory("p3-harness-e2e-");
		const t = await start();
		const id = await session(t, folder, [
			{ when: "@go", reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command: GATED }) }] },
			{ when: "", reply: [{ kind: "text", text: "after-archive" }] },
		]);
		const client = await t.client(context);
		await send(client, id, "@go");
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		await client.root(async (ctx) => {
			const held = await ctx.get(SessionObject, { workspace: id, thing: id });
			await withGranted(held, "archive")!.archive(ctx);
			await until(held.row, (row) => row.archivedAt !== null, within("archived", ctx));
			// Confirm this very worker has observed the archive before letting the tool finish.
			const transcript = withGranted(await ctx.get(Transcript, { session: id }), "stop")!;
			await assert.rejects(transcript.stop(ctx), /archived/);
			const probe = await ctx.get(FauxRequests, { session: id });
			await writeFile(join(folder, "gate"), "");
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.ok(
				!probe.requests.value.some((request) => request.last.includes(folder)),
				"archived session scheduled a new model request with the gated tool's result",
			);
		}, context);
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
			const transcript = withGranted(await ctx.get(Transcript, { session: id }), "view")!;
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
		const transcript = withGranted(await client.get(Transcript, { session: id }, context), "view", "send")!;
		await transcript.send({ text: "@go", requestId: "go" }, context);
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		// A real edit (a comment alone builds the same script, which reloads nothing; Astra, round 1).
		const file = join(built, "harness", "worker.ts");
		await writeFile(file, `${await readFile(file, "utf8")}\nexport const RELOADED = 1;\n`);
		await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
		const { steps } = await t.apply(context);
		const workers = steps.find((step) => step.name === "workers");
		assert.ok(
			workers?.hosts.some((host) => host.kind === "reloaded" && host.host === id),
			`the session's worker reloaded: ${JSON.stringify(steps)}`,
		);
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

// Astra, round 1 (should 9): the base bench's launched owner client scripts the faux login of its session.
describe("the faux login over a link", () => {
	it("is scripted from an owner client signed in over the network", async () => {
		const t = await start();
		const client = await ownerClient(t.dataDir, t.port, context, 5000);
		try {
			const id = await newSession(client, "bench", context);
			const login = await scriptFauxAs(client, id, [{ when: "", reply: [{ kind: "text", text: "ok" }] }], context);
			assert.ok(login !== "");
		} finally {
			await client.close(context);
		}
	});
});
