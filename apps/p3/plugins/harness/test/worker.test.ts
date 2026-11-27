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
import {
	allow,
	constant,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	isChordError,
	type JsonValue,
	type P3Principal,
	SessionFacts,
	until,
	type Watchable,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import {
	fauxProvider,
	LiveDoc,
	NodeExecutionEnv,
	type OpenHarness,
	ROOT_CONVERSATION_ID,
	SessionHarness,
	WorkerBusy,
} from "@earendil-works/p3/v1/worker";
import { FAUX_MODEL, FAUX_PROVIDER, keyOf } from "../../../test/plugins/faux-login/contract.ts";
import fauxWorker from "../../../test/plugins/faux-login/worker.ts";
import { eventually, within } from "../../../test/until.ts";
import { MachineKind } from "../../environments/kind.ts";
import environmentsWorker from "../../environments/worker.ts";
import { type LoginDefinitions, SessionModels } from "../../providers/contract.ts";
import { LoginKind } from "../../providers/kind.ts";
import providersWorker from "../../providers/worker.ts";
import type { HarnessSession } from "../../things/contract.worker.ts";
import { held as heldThing } from "../../things/test/part.ts";
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
		options: { readonly ready?: boolean } = {},
	): Promise<Server> {
		const { stubs, server, control } = standIns({ ...sessionRow(SESSION, folder), ...change }, held, extras, options);
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

	it("asks the session's chosen model with its thinking level (Astra, slice 5 round 1)", async () => {
		const a = login("a", "faux-a", [says("", "A")]);
		const b = login("b", "faux-b", [says("", "B")]);
		await start([a, b], { model: { login: "b", model: "faux-b-model", thinking: "high" } });
		await ask("one");
		assert.equal(requests()[0]?.provider, "faux-b");
		const agent = await (await (await harness()).durable.root(context)).agent(context);
		assert.equal(agent.thinkingLevel, "high");
	});

	it("picks the chosen model only once the logins' models are complete: a login given late is asked (Astra, round 1 of model settings)", async () => {
		const fallback = login("a", "faux-a", [says("", "A")]);
		const chosen = login("b", "faux-b", [says("", "B")]);
		const server = await start([fallback], { model: { login: "b", model: "faux-b-model", thinking: "high" } });
		let complete!: () => void;
		server.loading(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		const asked = ask("one");
		// The submit waits in `ready`; the chosen login's models arrive, then the list is complete.
		await eventually(
			() => server.readies,
			(readies) => readies > 0,
			5000,
		);
		server.hold([fallback, chosen]);
		complete();
		await asked;
		assert.deepEqual(
			requests().map(({ provider }) => provider),
			["faux-b"],
		);
	});

	// Astra, round 2: the real providers worker over a server whose models never get complete; the chosen login's
	// model is hidden (the server lists it without), the other login still offers it.
	it("asks no login past the bound while the models are not complete: the chosen model, hidden, fails no_model", async () => {
		const definitions = fauxProvider({ provider: FAUX_PROVIDER, api: "faux", models: [{ id: FAUX_MODEL }] }).models;
		const catalog: LoginDefinitions[] = [
			{ login: "other", models: [...definitions] },
			{ login: "chosen", models: [] },
		];
		const stalled = defineFacet((host) =>
			host.serve(
				SessionModels,
				() => ({
					complete: constant(false),
					models: constant([]),
					// pi-ai's definitions are JSON: the catalog as the member types it.
					catalog: () => constant(catalog as unknown as JsonValue) as unknown as Watchable<LoginDefinitions[]>,
				}),
				{ admit: () => constant(allow({ granted: ["catalog" as const] })) },
			),
		);
		const authorized: string[] = [];
		// The providers part reads a held login's `login` and `authorize` only.
		const heldLogin = (thing: string): Holding => ({
			kind: LoginKind.name,
			held: {
				workspace: SESSION,
				thing,
				depth: 0,
				ref: {
					login: constant({ provider: FAUX_PROVIDER, providerName: thing }),
					authorize: async () => {
						authorized.push(thing);
						return { auth: { apiKey: keyOf([says("", thing)]) } };
					},
				},
			} as unknown as Holding["held"],
		});
		const row = {
			...sessionRow(SESSION, folder),
			model: { login: "chosen", model: FAUX_MODEL, thinking: "low" },
		} as const;
		const { stubs, server, control } = standIns(row, [heldLogin("other"), heldLogin("chosen")]);
		harnessControl = control;
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{
				kind: "worker",
				session: SESSION,
				stubs: [
					...stubs,
					{ name: "p3-providers", facet: providersWorker },
					{ name: "p3-test-faux-login", facet: fauxWorker },
				],
				server: [...server, { name: "p3-test-stalled-models", facet: stalled }],
			},
			context,
		);
		await ask("one");
		assert.deepEqual(authorized, []);
		assert.equal((await live())?.runFailure?.reason, "no_model");
	});

	it("falls back past a login without models to the next one that has one (Astra, round 1 of model settings)", async () => {
		const empty = login("a", "faux-empty", []);
		const usable = login("b", "faux-b", [says("", "B")]);
		await start([empty, usable]);
		await ask("one");
		assert.deepEqual(
			requests().map(({ provider }) => provider),
			["faux-b"],
		);
	});

	it("falls back to the first login's model while the chosen one is not given (decision 118)", async () => {
		const a = login("a", "faux-a", [says("", "A")]);
		await start([a], { model: { login: "gone", model: "faux-gone-model", thinking: "off" } });
		await ask("one");
		assert.equal(requests()[0]?.provider, "faux-a");
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
		assert.equal(requests()[1]?.last, `folder: ${folder}`);
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

	it("runs no tool on a machine whose Work here is withheld: the real machine part, nothing falls back (ERNDL-1172)", async () => {
		const script = [runs("where", "pwd"), says("", "done")];
		const info = constant({ name: "box", type: "local", status: "ready" });
		const machine = (granted: string[]): Holding => ({
			kind: MachineKind.name,
			held: heldThing("m", granted, { info }),
		});
		const held = [login("login", "faux", script), coding(), machine(["work"])];
		const { stubs, server, control } = standIns(
			{ ...sessionRow(SESSION, folder), location: { environment: "m", folder } },
			held,
		);
		harnessControl = control;
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{
				kind: "worker",
				session: SESSION,
				stubs: [...stubs, { name: "@earendil-works/p3-environments", facet: environmentsWorker }],
				server,
			},
			context,
		);
		await ask("where");
		// Round 1's must 3 (Opus, Astra): Work here withheld from the agent, the machine stays held without it.
		control.hold([held[0]!, held[1]!, machine([])]);
		await ask("where now");
		const results = requests()
			.filter(({ last }) => !last.startsWith("where"))
			.map(({ last }) => last.trim());
		assert.equal(results[0], folder, "with Work here the tool runs in the location's folder");
		assert.match(results[1] ?? "", /No execution environment/, "without it there is none");
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

	it("ends a queued message whose subagent's run then failed, and reports it (Astra, round 1)", async () => {
		const tool = (when: string, name: string, args: object): Step => ({
			when,
			reply: [{ kind: "tool", name, args: JSON.stringify(args) }],
		});
		const script = [
			tool("@spawn", "subagent_spawn", { name: "reader", message: "child-start" }),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo not-scripted"),
			says("Started reader.", "ok"),
			tool("@queue", "subagent_send", { name: "reader", message: "later", followUp: true }),
			says("Sent to reader.", "ok"),
			says("[subagent reader failed:", "noted"),
		];
		await start([login("l", "faux", script), coding(), subagents()]);
		const open = await harness();
		try {
			await open.submit(undefined, { text: "@spawn", requestId: "spawn" }, context);
			await eventually(() => existsSync(join(folder, "started")), Boolean);
			await open.submit(undefined, { text: "@queue", requestId: "q" }, context);
			await eventually(
				() => open.durable.inspect(context),
				(found) =>
					found.submissions.some((s) => s.status === "queued" && s.requestId?.startsWith("subagent:") === true),
			);
			await writeFile(join(folder, "gate"), "");
			await eventually(
				() => requests(),
				(seen) => seen.some((request) => request.last.startsWith("[subagent reader failed:")),
				5000,
			);
			await eventually(
				() => open.durable.inspect(context),
				(found) => found.tasks.length === 0 && found.submissions.length === 0,
				5000,
			);
		} finally {
			await writeFile(join(folder, "gate"), "");
		}
	});

	it("sends to a subagent, whose answer comes back once; archived, it is gone from the list (Opus, round 1)", async () => {
		const tool = (when: string, name: string, args: object): Step => ({
			when,
			reply: [{ kind: "tool", name, args: JSON.stringify(args) }],
		});
		const script: Step[] = [
			tool("@spawn", "subagent_spawn", { name: "reader", message: "first task" }),
			says("Started reader.", "started"),
			says("first task", "first answer"),
			says("[subagent reader answered] first answer", "noted one"),
			tool("@send", "subagent_send", { name: "reader", message: "second task" }),
			says("Sent to reader.", "sent"),
			says("second task", "second answer"),
			says("[subagent reader answered] second answer", "noted two"),
			tool("@archive", "subagent_archive", { name: "reader" }),
			says("Archived reader.", "archived"),
			tool("@list", "subagent_list", {}),
			says("No subagents.", "none"),
			says("", "ok"),
		];
		await start([login("login", "faux", script), coding(), subagents()]);
		const answered = (text: string) =>
			eventually(
				() => requests().filter(({ last }) => last === `[subagent reader answered] ${text}`).length,
				(count) => count === 1,
				5000,
			);
		await ask("@spawn");
		await answered("first answer");
		await (await harness()).durable.waitForIdle(context);
		await ask("@send");
		await answered("second answer");
		await (await harness()).durable.waitForIdle(context);
		await ask("@archive");
		await ask("@list");
		assert.ok(requests().some(({ last }) => last === "No subagents."));
		// Each answer reported once.
		assert.equal(requests().filter(({ last }) => last.startsWith("[subagent reader answered]")).length, 2);
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

	it("gives a running subagent no new message once Use is withheld (ERNDL-1171, test 2)", async () => {
		const tool = (when: string, name: string, args: object): Step => ({
			when,
			reply: [{ kind: "tool", name, args: JSON.stringify(args) }],
		});
		const script: Step[] = [
			tool("@spawn", "subagent_spawn", { name: "reader", message: "child-start" }),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo first done"),
			says("Started reader.", "ok"),
			tool("@send", "subagent_send", { name: "reader", message: "a new message" }),
			says("", "ok"),
		];
		const held = [login("login", "faux", script), coding(), subagents()];
		const server = await start(held);
		const open = await harness();
		try {
			await open.submit(undefined, { text: "@spawn", requestId: "spawn" }, context);
			await eventually(() => existsSync(join(folder, "started")), Boolean);
			server.hold([held[0]!, held[1]!, subagents(false)]);
			await ask("@send");
			const offered = requests().find(({ last }) => last === "@send")?.tools ?? [];
			assert.ok(!offered.includes("subagent_send"), offered.join());
		} finally {
			await writeFile(join(folder, "gate"), "");
		}
		await open.durable.waitForIdle(context);
		// The running subagent finished its step; it never got the new message.
		assert.ok(!requests().some(({ last }) => last.includes("a new message")));
	});

	// Astra, round 1 (should 5).
	it("starts no pending submit when the session is archived while the holding gets ready", async () => {
		const held = [login("login", "faux", [says("", "ok")])];
		const server = await start(held, {}, [], { ready: false });
		const open = await harness();
		const pending = open.submit(undefined, { text: "hello", requestId: "hi" }, context);
		server.row({ archivedAt: 5 });
		const facts = await tested().host.get(SessionFacts, {}, context);
		await until(facts.session, (row) => row?.archivedAt === 5, within("the archive on the worker", context));
		server.hold(held);
		await assert.rejects(pending, (error) => isChordError(error) && error.code === "forbidden");
		assert.equal((await open.durable.inspect(context)).scheduling, "paused");
	});

	// Astra, round 1 (should 5).
	it("resumes nothing when the session is archived while the holding gets ready", async () => {
		const server = await start([], {}, [], { ready: false });
		const open = await harness();
		server.row({ archivedAt: 5 });
		const facts = await tested().host.get(SessionFacts, {}, context);
		await until(facts.session, (row) => row?.archivedAt === 5, within("the archive on the worker", context));
		server.hold([]);
		// The worker has seen the holding and run its routines.
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal((await open.durable.inspect(context)).scheduling, "paused");
	});

	// Decision 122 (round 2): a restore resumes nothing by itself; the next send does.
	it("resumes nothing when an archived session is restored", async () => {
		const server = await start([], { archivedAt: 5 });
		const open = await harness();
		server.row({ archivedAt: null });
		const facts = await tested().host.get(SessionFacts, {}, context);
		await until(facts.session, (row) => row?.archivedAt === null, within("the restore on the worker", context));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal((await open.durable.inspect(context)).scheduling, "paused");
	});
});
