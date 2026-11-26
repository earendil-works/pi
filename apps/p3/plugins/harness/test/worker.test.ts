// The harness plugin's worker facet alone (`testPlugin`), beside stand-ins for the server, the holding and a scripted
// login (`stubs.ts`) and the real things and tools plugins: the agent gets exactly what it holds (the coding tools,
// Bash withheld, the tools let go of between requests and during a call; a kind no part here serves gives nothing),
// a kind's part is called again only when its list changed, a part's prompt section and environment reach the agent,
// a login's model by default and a set model kept, `no_model` without a login, the activity reports (working before
// Durable takes the input, one per transition), `WorkerBusy` while working, an archived session that schedules
// nothing, and a tool's `session.call` reaching the server. The subagents' part is `subagents.test.ts`'s.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, isChordError, type P3Principal, until } from "@earendil-works/p3/v1";
import type { TestedPlugin } from "@earendil-works/p3/v1/testing";
import {
	LiveDoc,
	NodeExecutionEnv,
	type OpenHarness,
	ROOT_CONVERSATION_ID,
	WorkerBusy,
} from "@earendil-works/p3/v1/worker";
import { eventually, within } from "../../../test/until.ts";
import type { HarnessSession } from "../../things/contract.worker.ts";
import {
	coding,
	type Extra,
	type Harnessed,
	type Holding,
	harnessed,
	login,
	other,
	runs,
	type Server,
	says,
	sessionRow,
} from "./stubs.ts";

const SESSION = "s1";

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
	let loaded: Harnessed | undefined;

	beforeEach(async () => {
		folder = await realpath(await mkdtemp(join(tmpdir(), "p3-harness-")));
	});

	afterEach(async () => {
		await loaded?.t.close(context);
		loaded = undefined;
		await rm(folder, { recursive: true, force: true });
	});

	/** Loads the harness holding `held` (and the row's `change`, the `extras` parts); answers the stand-ins' controls. */
	async function start(
		held: Holding[],
		change: Partial<ReturnType<typeof sessionRow>> = {},
		extras: Extra[] = [],
		options: { readonly ready?: boolean } = {},
	): Promise<Server> {
		loaded = await harnessed({ ...sessionRow(SESSION, folder), ...change }, held, context, extras, options);
		return loaded.control;
	}

	function current(): Harnessed {
		assert.ok(loaded !== undefined);
		return loaded;
	}

	/** The open harness, once contributed. */
	function harness(): Promise<OpenHarness> {
		return current().harness();
	}

	function tested(): TestedPlugin<P3Principal> {
		return current().t;
	}

	/** Submits `text` to the root conversation and waits until the session is idle again. */
	function ask(text: string): Promise<void> {
		return current().ask(text);
	}

	/** What the scripted logins received so far. */
	function requests() {
		return current().control.requests;
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

	it("takes only bash from the offered tools when Bash is withheld: the kind keeps its place among the others", async () => {
		// The coding tools are held before the login, whose part gives a tool too.
		const faux = login("login", "faux", [says("", "ok")], true);
		const server = await start([coding(), faux]);
		await ask("one");
		server.hold([coding("tools", ["read", "write", "edit"]), faux]);
		await ask("two");
		assert.deepEqual(requests()[1]?.tools, ["edit", "read", "test_session", "write"]);
		// Durable removes and offers every tool again when their order changed: an extension replaced in place keeps it.
		assert.deepEqual(requests()[1]?.removed, ["bash"]);
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

	it("runs the tools where a part gives the location's environment; none there or the machine let go of: none", async () => {
		const elsewhere = join(folder, "machine");
		await mkdir(elsewhere);
		const script = [runs("where", "pwd"), says("", "done")];
		const held = [login("login", "faux", script), coding(), other("test.machine", "m")];
		// The machine part gives machine `m`'s environment only, in its own folder.
		const machine = (location: { machine: string }) =>
			location.machine === "m" ? new NodeExecutionEnv({ cwd: elsewhere }) : undefined;
		const server = await start(held, { location: { environment: "m", folder } }, [
			{ kind: "test.machine", env: machine },
		]);
		await ask("where");
		server.row({ location: { environment: "other", folder } });
		await ask("where then");
		server.hold([held[0]!, held[1]!]);
		await ask("where now");
		const results = requests()
			.filter(({ last }) => !last.startsWith("where"))
			.map(({ last }) => last.trim());
		assert.equal(results[0], elsewhere);
		assert.match(results[1] ?? "", /No execution environment/, "none on a machine the part does not give");
		// Astra and Opus, round 1: the machine let go of (Work withheld) leaves no environment, no fallback.
		assert.match(results[2] ?? "", /No execution environment/, "a machine part registered: no fallback");
	});

	it("tells a part where a conversation works: the session's location, live", async () => {
		const sessions: HarnessSession[] = [];
		const server = await start([other("test.located", "l")], {}, [
			{ kind: "test.located", seen: (session) => sessions.push(session) },
		]);
		await harness();
		const [session] = sessions;
		assert.ok(session !== undefined);
		assert.deepEqual(await session.location(ROOT_CONVERSATION_ID, context), { machine: "this-device", folder });
		server.row({ location: { environment: "m", folder: "/elsewhere" } });
		await eventually(
			() => session.location(ROOT_CONVERSATION_ID, context),
			(at) => at?.machine === "m" && at.folder === "/elsewhere",
		);
	});

	it("waits with the first submit until the holding is ready, which then gives the agent its tools", async () => {
		const held = [login("login", "faux", [says("", "ok")]), coding()];
		const server = await start([], {}, [], { ready: false });
		const open = await harness();
		const submitted = open.submit(undefined, { text: "hi", requestId: "hi" }, context);
		// The holding is slow: nothing reached the model while it was not ready.
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(requests(), []);
		server.hold(held);
		await submitted;
		await open.durable.waitForIdle(context);
		assert.deepEqual(requests()[0]?.tools, ["bash", "edit", "read", "write"]);
	});
});
