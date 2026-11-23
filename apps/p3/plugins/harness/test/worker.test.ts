// The harness plugin's worker facet alone (`testPlugin`), beside stand-ins for the server (`stubs.ts`) and the real
// tools and faux login plugins: the agent gets exactly the session's things (tools offered, removed between requests
// and during a call, without bash, nothing for options of another version), a login's model by default and a set model
// kept, `no_model` without a login, the activity reports (working before Durable takes the input, one per transition),
// `WorkerBusy` while working, an archived session that schedules nothing, and a tool's `Agent.call` reaching the server.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	isChordError,
	type P3Principal,
	SessionFacts,
	until,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import {
	LiveDoc,
	type OpenHarness,
	ROOT_CONVERSATION_ID,
	SessionHarness,
	WorkerBusy,
} from "@earendil-works/p3/v1/worker";
import { type FauxRequest, FauxRequests, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { eventually, within } from "../../../test/until.ts";
import { type Server, sessionRow, standIns, type Thing } from "./stubs.ts";

const SESSION = "s1";
/** The owner, as the stand-ins answer for them (a person who writes). */
const OWNER: P3Principal = { kind: "person", id: "owner", name: "Owner" };

/** A faux login thing `thing` of provider `provider` answering from `script`. */
function login(thing: string, provider: string, script: Step[], tool = false): Thing {
	return { thing, kind: "faux.login", name: "", version: 1, options: { provider, script, tool } };
}

/** The coding tools thing. */
function coding(shell = true): Thing {
	return { thing: "tools", kind: "tools.coding", name: "", version: 1, options: { shell } };
}

/** A scripted step answering `when` with text. */
function says(when: string, text: string): Step {
	return { when, reply: [{ kind: "text", text }] };
}

/** A scripted step answering `when` with a bash call. */
function runs(when: string, command: string): Step {
	return { when, reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command }) }] };
}

/** Waits until the worker's reports are `states` (a routine reports after the commit that changed the state). */
async function reported(server: Server, states: string[]): Promise<void> {
	await eventually(
		() => server.reports,
		(reports) => reports.length >= states.length,
		5000,
	);
	assert.deepEqual(server.reports, states);
}

describe("the harness plugin on a worker", () => {
	let folder: string;
	let t: TestedPlugin<P3Principal> | undefined;

	beforeEach(async () => {
		folder = await realpath(await mkdtemp(join(tmpdir(), "p3-harness-")));
	});

	afterEach(async () => {
		await t?.close(context);
		t = undefined;
		await rm(folder, { recursive: true, force: true });
	});

	/** Loads the harness with the session's `things` (and the row's `change`); answers the server's controls. */
	async function start(things: Thing[], change: Partial<ReturnType<typeof sessionRow>> = {}): Promise<Server> {
		const { stubs, server, control } = standIns({ ...sessionRow(SESSION, folder), ...change }, things);
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{ kind: "worker", session: SESSION, stubs, server },
			context,
		);
		return control;
	}

	/** The open harness, once contributed. */
	async function harness(): Promise<OpenHarness> {
		const registry = await tested().host.registry(SessionHarness, context);
		const open = await until(registry, (value) => value !== undefined, within("the harness", context));
		assert.ok(open !== undefined);
		return open;
	}

	function tested(): TestedPlugin<P3Principal> {
		assert.ok(t !== undefined);
		return t;
	}

	/** Submits `text` to the root conversation and waits until the session is idle again. */
	async function ask(text: string): Promise<void> {
		const open = await harness();
		await open.submit(undefined, { text, requestId: text }, context);
		await open.durable.waitForIdle(context);
	}

	/** Waits until the worker has facts from the server that pass `done` (a change made there travels to it). */
	async function arrived(done: (facts: { kinds: readonly unknown[] }) => boolean): Promise<void> {
		await tested().root(async (ctx) => {
			const facts = await ctx.get(SessionFacts, {});
			await until(facts.kinds, (kinds) => done({ kinds }), within("the facts", ctx));
		}, context);
	}

	/** What the faux logins received so far. */
	async function requests(): Promise<FauxRequest[]> {
		return tested().root(async (ctx) => (await ctx.get(FauxRequests, { session: SESSION })).requests.value, context, {
			principal: OWNER,
		});
	}

	/** The root conversation's `pi.live` document. */
	async function live() {
		return (await harness()).durable.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
	}

	it("answers a scripted request; the tool call runs in the session's folder", async () => {
		const server = await start([login("login", "faux", [runs("hi", "pwd"), says(folder, "done")]), coding()]);
		await ask("hi");
		const [first, second] = await requests();
		assert.deepEqual(first?.tools, ["bash", "edit", "read", "write"]);
		assert.ok(second?.last.includes(folder), `the tool ran in the session's folder: ${second?.last}`);
		assert.equal((await requests()).length, 2);
		await reported(server, ["working", "settled"]);
		assert.deepEqual(tested().errors, []);
	});

	it("leaves bash out with shell off", async () => {
		await start([login("login", "faux", [says("hi", "hello")]), coding(false)]);
		await ask("hi");
		assert.deepEqual((await requests())[0]?.tools, ["edit", "read", "write"]);
	});

	it("offers no tools to the next request once the tools left the session", async () => {
		const server = await start([login("login", "faux", [says("", "ok")]), coding()]);
		await ask("one");
		server.things([login("login", "faux", [says("", "ok")])]);
		await ask("two");
		assert.deepEqual(
			(await requests()).map((request) => request.tools),
			[["bash", "edit", "read", "write"], []],
		);
	});

	it("finishes a call running when the tools leave, and starts no later one", async () => {
		const script = [
			runs("go", "touch started; until [ -e gate ]; do sleep 0.02; done; echo first"),
			runs("first", "echo second > second.txt"),
			says("", "end"),
		];
		const server = await start([login("login", "faux", script), coding()]);
		const open = await harness();
		await open.submit(undefined, { text: "go", requestId: "go" }, context);
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		server.things([login("login", "faux", script)]);
		await writeFile(join(folder, "gate"), "");
		await open.durable.waitForIdle(context);
		const [, second, third] = await requests();
		assert.ok(second?.last.includes("first"), "the running call finished");
		assert.deepEqual(second?.tools, [], "the next request offered no tools");
		assert.ok(third !== undefined && !existsSync(join(folder, "second.txt")), "no later call ran");
	});

	it("gives a thing whose options are of another version than its kind on this worker nothing", async () => {
		const server = await start([{ ...login("login", "faux", [says("", "ok")]), version: 2 }, coding()]);
		await ask("hi");
		assert.deepEqual(await requests(), []);
		assert.equal((await live())?.runFailure?.reason, "no_model");
		await reported(server, ["working", "failed"]);
	});

	it("gives a thing whose kind no plugin on the worker serves nothing, and the others theirs", async () => {
		await start([
			{ thing: "x", kind: "elsewhere.kind", name: "", version: 1, options: {} },
			login("login", "faux", [says("", "ok")]),
			coding(),
		]);
		await ask("hi");
		assert.deepEqual((await requests())[0]?.tools, ["bash", "edit", "read", "write"]);
	});

	it("fails no_model visibly without a login", async () => {
		const server = await start([coding()]);
		await ask("hi");
		assert.equal((await live())?.runFailure?.reason, "no_model");
		await reported(server, ["working", "failed"]);
	});

	it("gives a conversation without a model the first login's, and keeps a set model when another login comes", async () => {
		const a = login("a", "faux-a", [says("", "from a")]);
		const b = login("b", "faux-b", [says("", "from b")]);
		const server = await start([a, b]);
		await ask("one");
		const root = await (await harness()).durable.root(context);
		await root.configure({ model: { provider: "faux-b", modelId: "faux-b-model" } }, context);
		server.things([a, b, login("c", "faux-c", [says("", "from c")])]);
		await ask("two");
		// The set model is no longer offered: the first login's again.
		server.things([a]);
		await ask("three");
		assert.deepEqual(
			(await requests()).map((request) => request.provider),
			["faux-a", "faux-b", "faux-a"],
		);
	});

	it("reports working before Durable takes the input", async () => {
		const server = await start([login("login", "faux", [says("", "ok")])]);
		const open = await harness();
		const release = Promise.withResolvers<void>();
		server.hold(release.promise);
		const submitted = open.submit(undefined, { text: "hi", requestId: "hi" }, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const root = await open.durable.root(context);
		assert.deepEqual(
			(await root.entries({}, 10, undefined, context)).items,
			[],
			"no input taken while the report waits",
		);
		assert.deepEqual(await requests(), []);
		release.resolve();
		await submitted;
		await open.durable.waitForIdle(context);
		await reported(server, ["working", "settled"]);
	});

	it("counts 1 in WorkerBusy while working", async () => {
		await start([
			login("login", "faux", [runs("go", "until [ -e gate ]; do sleep 0.02; done"), says("", "end")]),
			coding(),
		]);
		const open = await harness();
		const busy = await tested().host.registry(WorkerBusy, context);
		await open.submit(undefined, { text: "go", requestId: "go" }, context);
		await until(busy, (count) => count === 1, within("busy", context));
		await writeFile(join(folder, "gate"), "");
		await until(busy, (count) => count === 0, within("idle", context, 5000));
	});

	it("schedules nothing for an archived session and refuses its submit", async () => {
		await start([login("login", "faux", [says("", "ok")])], { archivedAt: 5 });
		const open = await harness();
		await assert.rejects(
			open.submit(undefined, { text: "hi", requestId: "hi" }, context),
			(error) => isChordError(error) && error.code === "forbidden",
		);
		assert.equal((await open.durable.inspect(context)).scheduling, "paused");
	});

	it("gives a thing's tool the agent, whose call reaches the server as the worker", async () => {
		await start([
			login(
				"login",
				"faux",
				[{ when: "who", reply: [{ kind: "tool", name: "faux_session", args: "{}" }] }, says("", "ok")],
				true,
			),
		]);
		await ask("who");
		assert.equal((await requests())[1]?.last, "title: Test session");
	});

	it("gives the tools of two coding tools things once, bash when one of them has shell on", async () => {
		await start([
			login("login", "faux", [says("", "ok")]),
			{ ...coding(false), thing: "tools-a" },
			{ ...coding(true), thing: "tools-b" },
		]);
		await ask("hi");
		assert.deepEqual((await requests())[0]?.tools, ["bash", "edit", "read", "write"]);
	});

	it("offers thing_create only while the session has content kinds, and makes content there through the server", async () => {
		const make = {
			kind: "tool" as const,
			name: "thing_create",
			args: JSON.stringify({ kind: "test.board", name: "Plan" }),
		};
		const odd = {
			kind: "tool" as const,
			name: "thing_create",
			args: JSON.stringify({ kind: "test.other", name: "X" }),
		};
		const server = await start([
			login("login", "faux", [{ when: "@make", reply: [make] }, { when: "@odd", reply: [odd] }, says("", "ok")]),
		]);
		await ask("plain");
		server.kinds([{ kind: "test.board", title: "Board" }]);
		await arrived((facts) => facts.kinds.length === 1);
		await ask("@make");
		await ask("@odd");
		server.kinds([]);
		await arrived((facts) => facts.kinds.length === 0);
		await ask("again");
		const seen = await requests();
		assert.deepEqual(
			seen.map(({ last, tools }) => [last, tools.includes("thing_create")]),
			[
				["plain", false],
				["@make", true],
				['Made Board "Plan": id made-1.', true],
				["@odd", true],
				[seen[4]?.last, true],
				["again", false],
			],
		);
		assert.match(seen[4]?.last ?? "", /no kind test\.other; its kinds: `test\.board` \(Board\)/);
		assert.deepEqual(server.created, [{ kind: "test.board", name: "Plan" }]);
	});
});
