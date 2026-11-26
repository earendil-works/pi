// The harness plugin's worker facet alone (`testPlugin`), beside stand-ins for the server, the holding and a scripted
// login (`stubs.ts`) and the real things and tools plugins: the agent gets exactly what it holds (the coding tools,
// Bash withheld, the tools let go of between requests and during a call; a kind no part here serves gives nothing),
// a kind's part is called again only when its list changed, a part's prompt section and environment reach the agent,
// a login's model by default and a set model kept, `no_model` without a login, the activity reports (working before
// Durable takes the input, one per transition), `WorkerBusy` while working, an archived session that schedules
// nothing, and a tool's `session.call` reaching the server.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, isChordError, type P3Principal, until } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import {
	LiveDoc,
	NodeExecutionEnv,
	type OpenHarness,
	ROOT_CONVERSATION_ID,
	SessionHarness,
	WorkerBusy,
} from "@earendil-works/p3/v1/worker";
import { eventually, within } from "../../../test/until.ts";
import {
	coding,
	type Extra,
	type Holding,
	login,
	other,
	type Server,
	type Step,
	sessionRow,
	standIns,
	subagents,
} from "./stubs.ts";

const SESSION = "s1";

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
	let harnessControl: Server | undefined;

	beforeEach(async () => {
		folder = await realpath(await mkdtemp(join(tmpdir(), "p3-harness-")));
	});

	afterEach(async () => {
		await t?.close(context);
		t = undefined;
		await rm(folder, { recursive: true, force: true });
	});

	/** Loads the harness holding `held` (and the row's `change`, the `extras` parts); answers the stand-ins' controls. */
	async function start(
		held: Holding[],
		change: Partial<ReturnType<typeof sessionRow>> = {},
		extras: Extra[] = [],
	): Promise<Server> {
		const { stubs, server, control } = standIns({ ...sessionRow(SESSION, folder), ...change }, held, extras);
		harnessControl = control;
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

	/** What the scripted logins received so far. */
	function requests() {
		assert.ok(harnessControl !== undefined);
		return harnessControl.requests;
	}

	/** The root conversation's `pi.live` document. */
	async function live() {
		return (await harness()).durable.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
	}

	it("answers a scripted request; the tool call runs in the session's folder", async () => {
		const server = await start([login("login", "faux", [runs("hi", "pwd"), says(folder, "done")]), coding()]);
		await ask("hi");
		const [first, second] = requests();
		assert.deepEqual(first?.tools, ["bash", "edit", "read", "write"]);
		assert.ok(second?.last.includes(folder), `the tool ran in the session's folder: ${second?.last}`);
		assert.equal(requests().length, 2);
		await reported(server, ["working", "settled"]);
		assert.deepEqual(tested().errors, []);
	});

	it("leaves bash out with Bash withheld", async () => {
		await start([login("login", "faux", [says("hi", "hello")]), coding("tools", ["read", "write", "edit"])]);
		await ask("hi");
		assert.deepEqual(requests()[0]?.tools, ["edit", "read", "write"]);
	});

	it("offers no tools to the next request once the agent let go of the tools", async () => {
		const held = [login("login", "faux", [says("", "ok")]), coding()];
		const server = await start(held);
		await ask("one");
		server.hold([held[0]!]);
		await ask("two");
		assert.deepEqual(
			requests().map((request) => request.tools),
			[["bash", "edit", "read", "write"], []],
		);
	});

	it("finishes a call running when the tools leave, and starts no later one", async () => {
		const script = [
			runs("go", "touch started; until [ -e gate ]; do sleep 0.02; done; echo first"),
			runs("first", "echo second > second.txt"),
			says("", "end"),
		];
		const held = [login("login", "faux", script), coding()];
		const server = await start(held);
		const open = await harness();
		await open.submit(undefined, { text: "go", requestId: "go" }, context);
		await eventually(() => existsSync(join(folder, "started")), Boolean);
		server.hold([held[0]!]);
		await writeFile(join(folder, "gate"), "");
		await open.durable.waitForIdle(context);
		const [, second, third] = requests();
		assert.ok(second?.last.includes("first"), "the running call finished");
		assert.deepEqual(second?.tools, [], "the next request offered no tools");
		assert.ok(third !== undefined && !existsSync(join(folder, "second.txt")), "no later call ran");
	});

	it("gives a held thing whose kind has no part here nothing, and the others theirs", async () => {
		await start([other("elsewhere.kind", "x"), login("login", "faux", [says("", "ok")]), coding()]);
		await ask("hi");
		assert.deepEqual(requests()[0]?.tools, ["bash", "edit", "read", "write"]);
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
		server.hold([a, b, login("c", "faux-c", [says("", "from c")])]);
		await ask("two");
		// The set model is no longer offered: the first login's again.
		server.hold([a]);
		await ask("three");
		assert.deepEqual(
			requests().map((request) => request.provider),
			["faux-a", "faux-b", "faux-a"],
		);
	});

	it("reports working before Durable takes the input", async () => {
		const server = await start([login("login", "faux", [says("", "ok")])]);
		const open = await harness();
		const release = Promise.withResolvers<void>();
		server.slow(release.promise);
		const submitted = open.submit(undefined, { text: "hi", requestId: "hi" }, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const root = await open.durable.root(context);
		assert.deepEqual(
			(await root.entries({}, 10, undefined, context)).items,
			[],
			"no input taken while the report waits",
		);
		assert.deepEqual(requests(), []);
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

	it("gives a part's tool the session, whose call reaches the server as the worker", async () => {
		await start([
			login(
				"login",
				"faux",
				[{ when: "who", reply: [{ kind: "tool", name: "test_session", args: "{}" }] }, says("", "ok")],
				true,
			),
		]);
		await ask("who");
		assert.equal(requests()[1]?.last, "title: Test session");
	});

	it("calls a kind's part again only when its list changed", async () => {
		const held = [login("login", "faux", [says("", "ok")]), coding()];
		const server = await start(held);
		await ask("one");
		const before = server.given.get("test.login");
		// The coding tools let go of: the login's list is the same array, its part is not called again.
		server.hold([held[0]!]);
		await ask("two");
		assert.equal(server.given.get("test.login"), before);
		// Another login: the login's list is new.
		server.hold([held[0]!, login("other", "faux-b", [says("", "ok")])]);
		await ask("three");
		assert.equal(server.given.get("test.login"), (before ?? 0) + 1);
	});

	it("puts a part's prompt sections into the agent's prompt, and drops them with the thing", async () => {
		const held = [login("login", "faux", [says("", "ok")]), other("test.prompted", "p")];
		const server = await start(held, {}, [{ kind: "test.prompted", prompt: "Always answer in rhymes." }]);
		await ask("one");
		server.hold([held[0]!]);
		await ask("two");
		assert.deepEqual(
			requests().map(({ prompt }) => prompt.includes("Always answer in rhymes.")),
			[true, false],
		);
	});

	it("runs the tools in the environment a part gives, else at the session's location", async () => {
		const elsewhere = join(folder, "machine");
		await mkdir(elsewhere);
		const script = [runs("where", "pwd"), says("", "done")];
		const held = [login("login", "faux", script), coding(), other("test.machine", "m")];
		const server = await start(held, {}, [
			{ kind: "test.machine", env: () => new NodeExecutionEnv({ cwd: elsewhere }) },
		]);
		await ask("where");
		server.hold([held[0]!, held[1]!]);
		await ask("where now");
		const results = requests().filter(({ last }) => last.startsWith("/"));
		assert.deepEqual(
			results.map(({ last }) => last.trim()),
			[elsewhere, folder],
		);
	});

	it("starts a subagent, a copy without the subagent tools, whose answer comes back; Use withheld: no tools", async () => {
		const tool = (name: string, args: object): Step => ({
			when: "",
			reply: [{ kind: "tool", name, args: JSON.stringify(args) }],
		});
		const script: Step[] = [
			{ ...tool("subagent_spawn", { name: "reader", message: "Summarize the plan" }), when: "@spawn" },
			says("Started reader.", "started"),
			says("Summarize the plan", "the summary"),
			says("[subagent reader answered] the summary", "noted"),
			{ ...tool("subagent_list", {}), when: "@list" },
			says("reader: idle", "listed"),
			says("", "ok"),
		];
		const held = [login("login", "faux", script), coding(), subagents()];
		const server = await start(held);
		await ask("@spawn");
		await eventually(
			() => requests().map(({ last }) => last),
			(lasts) => lasts.includes("[subagent reader answered] the summary"),
			5000,
		);
		await (await harness()).durable.waitForIdle(context);
		const child = requests().find(({ last }) => last === "Summarize the plan");
		assert.deepEqual(child?.tools, ["bash", "edit", "read", "write"], "the subagent has no subagent tools");
		assert.deepEqual(requests()[0]?.tools, [
			"bash",
			"edit",
			"read",
			"subagent_archive",
			"subagent_list",
			"subagent_send",
			"subagent_spawn",
			"write",
		]);
		await ask("@list");
		assert.ok(requests().some(({ last }) => last === "reader: idle"));
		server.hold([held[0]!, held[1]!, subagents(false)]);
		await ask("after");
		assert.deepEqual(requests().at(-1)?.tools, ["bash", "edit", "read", "write"]);
	});
});
