// In-place relocation inside one worker host, without processes: the real Harness moves (`Harness.relocate`: switch the
// environments, commit the agent cwds, commit the location) and the plugins following the location react. A stub
// "remote" provider supplies controllable environments for other machines; the subagents plugin's placement places
// conversations with their own location (seeded into its registry).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentDoc, type ConversationId, configure, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT, type Context, type Held, whenLive } from "@p2/app/v1";
import devToolsWorker from "../../plugins/dev-tools/worker.ts";
import fileIndexWorker from "../../plugins/file-index/worker.ts";
import { createP2Models } from "../../plugins/models/models.ts";
import { PowerShell } from "../../plugins/powershell/contract.ts";
import powershellWorker, { offersPowerShell } from "../../plugins/powershell/worker.ts";
import { Subagents as Registry } from "../../plugins/subagents/contract.worker.ts";
import { ownLocation, placeSubagents, spawnEnvironments } from "../../plugins/subagents/tools.ts";
import { WorkspaceBackend } from "../../plugins/workspace/contract.ts";
import workspaceWorker from "../../plugins/workspace/worker.ts";
import { type Ctx, createHost, defineFacet, Session } from "../../src/runtime/chord.ts";
import { durableContext, ExtensionSwitches } from "../../src/runtime/durable.ts";
import { FileIndexCache } from "../../src/runtime/file-index.ts";
import { HOST } from "../../src/runtime/principals.ts";
import {
	ConversationLocations,
	type ConversationPlacement,
	conversationEnvironment,
	HarnessConfig,
	HarnessEnvironments,
	HarnessHost,
	HarnessNative,
	Liveness,
	type Location,
	SessionLocation,
	type WorkerInit,
	workerCore,
} from "../../src/runtime/worker.ts";
import { poll, until } from "./helpers.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };
const CHECKOUT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A "remote" environment that actually runs here (a NodeExecutionEnv), with a controllable `canonicalPath` and the
 * system its connection reports (as `RemoteExecutionEnv.connection.info()` does).
 */
class TestEnv extends NodeExecutionEnv {
	readonly connection: { info(): Promise<{ os: string }> };
	readonly #machine: Machine;
	constructor(cwd: string, machine: Machine) {
		super({ cwd });
		this.#machine = machine;
		this.connection = { info: async () => ({ os: machine.os }) };
	}
	override async canonicalPath(path: string, context: Context) {
		await this.#machine.gate;
		if (this.#machine.failures > 0) {
			this.#machine.failures--;
			throw new Error("connection lost");
		}
		return super.canonicalPath(path, context);
	}
}
type Machine = { os: string; gate: Promise<void>; failures: number };

const models = defineFacet((_host, self) =>
	self.contribute(HarnessConfig, { default: { models: () => createP2Models(true), settings: () => ({}) } }),
);
/** The subagents plugin's placement (its worker facet needs the server's subagent list). */
const locations = defineFacet((_host, self) =>
	self.contribute(ConversationLocations, {
		subagents: {
			place: (harness, _session, _values, context) =>
				placeSubagents(harness, spawnEnvironments(undefined, null), context),
			own: ownLocation,
		} satisfies ConversationPlacement,
	}),
);

/** A worker host at `start` with the Harness, workspace, file index, dev-tools and PowerShell; machines by env name. */
async function worker(t: test.TestContext, start: Location, machines: Record<string, Machine>) {
	const root = mkdtempSync(join(tmpdir(), "p2-relocate-worker-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dataDir = join(root, "data");
	mkdirSync(join(dataDir, "sessions"), { recursive: true });
	/** Machines opened and closed, by environment name. */
	const opened: string[] = [];
	const closed: string[] = [];
	const remote = defineFacet((_host, self) =>
		self.contribute(HarnessEnvironments, {
			remote: {
				open: async (env) => {
					const machine = machines[env];
					if (!machine) throw new Error(`Environment "${env}" is not configured`);
					opened.push(env);
					return {
						at: (directory: string) => new TestEnv(directory, machine),
						close: () => closed.push(env),
					};
				},
				describe: async (env) => `the test machine ${env}`,
				sandbox: () => false,
			},
		}),
	);
	const host = createHost({
		address: Session({ id: "s1" }),
		principal: HOST,
		onError: (error) => console.error(error),
	});
	const init: WorkerInit = {
		app: CHECKOUT,
		dataDir,
		fake: true,
		generation: 1,
		values: { session: { id: "s1", ...start, model: MODEL, thinkingLevel: "off" } },
	};
	const location = new SessionLocation(start);
	const core = workerCore(init, new Liveness(), location, (fn) => host.root(fn, BACKGROUND_CONTEXT));
	await host.load(
		[
			{ name: "@p2/core", facet: core },
			{ name: "models", facet: models },
			{ name: "remote", facet: remote },
			{ name: "locations", facet: locations },
			{ name: "workspace", facet: workspaceWorker },
			{ name: "file-index", facet: fileIndexWorker },
			{ name: "dev-tools", facet: devToolsWorker },
			{ name: "powershell", facet: powershellWorker },
		],
		BACKGROUND_CONTEXT,
	);
	const holder = host.hold(HarnessHost, {}, BACKGROUND_CONTEXT);
	await whenLive(holder);
	const harness = (await host.registry(HarnessNative, BACKGROUND_CONTEXT)).value!;
	t.after(async () => {
		holder.release();
		await host.close(BACKGROUND_CONTEXT);
	});
	const relocate = (next: Location) => host.root((ctx: Ctx) => harness.relocate(next, ctx), BACKGROUND_CONTEXT);
	/** A subagent conversation working at `own` (its own location), else following the session. */
	const subagent = async (name: string, own?: Location, tools?: string[]): Promise<ConversationId> => {
		const durable = harness.durable;
		const context = durableContext(new AbortController().signal);
		const conversation = await durable.createConversation({ ownership: { kind: "ownerless" } }, context);
		await durable.commit(async (tx) => {
			await configure(tx, conversation.id, { model: MODEL, cwd: own?.cwd ?? location.value.cwd });
			if (tools) (await tx.doc(AgentDoc, conversation.id)).tools = tools;
			(await tx.doc(Registry, ROOT_CONVERSATION_ID)).agents[name] = {
				conversationId: conversation.id,
				model: "faux/faux-1",
				thinkingLevel: "off",
				tools: [],
				...(own ? { location: own } : {}),
				reported: [],
			};
		}, context);
		return conversation.id;
	};
	/** Where conversation `id` works and its environment, as Durable gets it. */
	const environment = (id: number) =>
		conversationEnvironment(harness.environments, id as ConversationId, durableContext(new AbortController().signal));
	/** The agent cwd Durable stores for conversation `id`. */
	const agentCwd = async (id: ConversationId) => {
		const context = durableContext(new AbortController().signal);
		return (await (await harness.durable.conversation(id, context))?.agent(context))?.cwd;
	};
	/** What Durable stores as conversation `id`'s agent choices. */
	const agentState = (id: number) =>
		harness.durable.snapshot(AgentDoc, id as ConversationId, durableContext(new AbortController().signal));
	return { root, dataDir, host, location, relocate, subagent, environment, agentCwd, agentState, opened, closed };
}

/** Runs `command` in `env` and returns its output. */
async function run(env: ExecutionEnv, command: string): Promise<string> {
	let output = "";
	const result = await env.exec(
		command,
		{
			onOutput: (text) => {
				output += text;
			},
		},
		durableContext(new AbortController().signal),
	);
	assert(result.ok, result.ok ? "" : result.error.message);
	return output.trim();
}

const directory = (parent: string, name: string, files: string[] = []) => {
	const path = join(parent, name);
	mkdirSync(path, { recursive: true });
	for (const file of files) writeFileSync(join(path, file), "");
	return path;
};

test("dev-tools and PowerShell detect again after a real move", async (t) => {
	const saved = process.env.P2_DEV;
	process.env.P2_DEV = "1";
	t.after(() => {
		if (saved === undefined) delete process.env.P2_DEV;
		else process.env.P2_DEV = saved;
	});
	const machines = { win: { os: "windows", gate: Promise.resolve(), failures: 0 } };
	const w = await worker(t, { cwd: CHECKOUT, env: null }, machines);
	const elsewhere = directory(w.root, "elsewhere");
	await w.host.root(async (ctx) => {
		const powershell = await ctx.get(PowerShell, {});
		const switches = await w.host.registry(ExtensionSwitches, ctx);
		const offered = () => switches.value.get("p2-dev-tools");
		await until(switches, () => offered() === true);
		await until(powershell.offered, (value) => value?.["1"] === (process.platform === "win32"));
		await w.relocate({ cwd: elsewhere, env: null });
		await until(switches, () => offered() === false);
		await w.relocate({ cwd: elsewhere, env: "win" });
		await until(powershell.offered, (value) => value?.["1"] === true);
		assert.equal(offered(), false, "never on a remote environment");
		await w.relocate({ cwd: CHECKOUT, env: null });
		await until(powershell.offered, (value) => value?.["1"] === (process.platform === "win32"));
		await until(switches, () => offered() === true);
	}, BACKGROUND_CONTEXT);
});

// The location lags behind the environments during a move: the private data directory is denied by what the
// environment is (here a "remote" location whose environment runs on this machine), never by the location's name.
test("the private data directory is denied by the environment, not the location", async (t) => {
	const machines = { box: { os: "linux", gate: Promise.resolve(), failures: 0 } };
	const parent = mkdtempSync(join(tmpdir(), "p2-relocate-parent-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const w = await worker(t, { cwd: parent, env: null }, machines);
	// The session works in the directory holding p2's data directory, on a location named as another machine.
	await w.relocate({ cwd: w.root, env: "box" });
	await w.host.root(async (ctx) => {
		const backend = await ctx.get(WorkspaceBackend, { conversation: 1 });
		await assert.rejects(backend.query({ kind: "list", path: "data" }, ctx), /private/);
		const index = await ctx.get(FileIndexCache, { conversation: 1 });
		const all = await index.complete({ query: "", limit: 100 }, ctx);
		assert(!all.items.some((item) => item.path === "data" || item.path.startsWith("data/")));
		index.release();
		backend.release();
	}, BACKGROUND_CONTEXT);
});

test("a workspace follows a move made while it activates, and retries a failed reopen", async (t) => {
	let open = () => {};
	const blocked: Machine = {
		os: "linux",
		gate: new Promise<void>((resolve) => {
			open = resolve;
		}),
		failures: 0,
	};
	const flaky: Machine = { os: "linux", gate: Promise.resolve(), failures: 0 };
	const machines = { blocked, other: { os: "linux", gate: Promise.resolve(), failures: 0 }, flaky };
	const parent = mkdtempSync(join(tmpdir(), "p2-relocate-parent-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const first = directory(parent, "first", ["first.txt"]);
	const second = directory(parent, "second", ["second.txt"]);
	const third = directory(parent, "third", ["third.txt"]);
	const w = await worker(t, { cwd: first, env: "blocked" }, machines);
	await w.host.root(async (ctx) => {
		const list = async (ref: Held<typeof WorkspaceBackend>) => {
			const result = await ref.query({ kind: "list", path: "" }, ctx);
			assert(result.kind === "list");
			return result.entries.map((entry) => entry.name);
		};
		// The workspace activates on the blocked machine; the session moves meanwhile.
		// Held, not awaited: its activation waits for the blocked machine.
		const backend = w.host.hold(WorkspaceBackend, { conversation: 1 }, BACKGROUND_CONTEXT);
		const ready = whenLive(backend);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await w.relocate({ cwd: second, env: "other" });
		open();
		await ready;
		assert.deepEqual(await list(backend), ["second.txt"]);
		// One failed reopen (a dropped connection) is not kept: the next use opens again.
		flaky.failures = 1;
		await w.relocate({ cwd: third, env: "flaky" });
		await poll(
			async () => (await list(backend).catch((): string[] => [])).includes("third.txt"),
			5000,
			"the reopened workspace",
		);
		backend.release();
	}, BACKGROUND_CONTEXT);
});

// The owner's case: the main conversation moves to the laptop; a subagent spawned with its own directory on the phone
// stays there and can still run tools; a subagent spawned without one follows the session.
test("the session moves to another machine; a subagent with its own location stays on its own", async (t) => {
	const laptop: Machine = { os: "linux", gate: Promise.resolve(), failures: 0 };
	const parent = mkdtempSync(join(tmpdir(), "p2-relocate-own-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const start = directory(parent, "start", ["start.txt"]);
	const own = directory(parent, "own", ["own.txt"]);
	const remote = directory(parent, "remote", ["remote.txt"]);
	const w = await worker(t, { cwd: start, env: null }, { laptop });
	const mine = await w.subagent("mine", { cwd: own, env: null });
	const follower = await w.subagent("follower");

	await w.relocate({ cwd: remote, env: "laptop" });
	const [main, kept, followed] = await Promise.all([w.environment(1), w.environment(mine), w.environment(follower)]);
	assert.deepEqual(main.location, { cwd: remote, env: "laptop" });
	assert(main.env instanceof TestEnv, "the main conversation runs on the laptop");
	assert.deepEqual(followed.location, { cwd: remote, env: "laptop" });
	assert.equal(followed.env, main.env, "a follower shares the session's environment");
	assert.deepEqual(kept.location, { cwd: own, env: null });
	assert(!(kept.env instanceof TestEnv), "the subagent stays on this machine");
	assert.equal(await run(kept.env, "pwd"), own);
	assert.equal(await run(followed.env, "pwd"), remote);
	assert.equal(await w.agentCwd(follower), remote);
	assert.equal(await w.agentCwd(mine), own);
	assert.deepEqual(w.opened, ["laptop"]);

	// The workspace and the file index of each conversation show where it works.
	await w.host.root(async (ctx) => {
		const names = async (conversation: number) => {
			const backend = await ctx.get(WorkspaceBackend, { conversation });
			const result = await backend.query({ kind: "list", path: "" }, ctx);
			backend.release();
			assert(result.kind === "list");
			return result.entries.map((entry) => entry.name);
		};
		assert.deepEqual(await names(mine), ["own.txt"]);
		assert.deepEqual(await names(follower), ["remote.txt"]);
		assert.deepEqual(await names(1), ["remote.txt"]);
		const index = await ctx.get(FileIndexCache, { conversation: mine });
		assert.deepEqual(
			(await index.complete({ query: "", limit: 10 }, ctx)).items.map((item) => item.path),
			["own.txt"],
		);
		index.release();
	}, BACKGROUND_CONTEXT);

	// Back on this machine: nothing works on the laptop any more, so its connection closes.
	await w.relocate({ cwd: start, env: null });
	assert.deepEqual(w.closed, ["laptop"]);
	assert.equal(await run((await w.environment(follower)).env, "pwd"), start);
	assert.equal(await run((await w.environment(mine)).env, "pwd"), own);
});

test("conversations on different machines run concurrently, one connection per machine", async (t) => {
	const laptop: Machine = { os: "linux", gate: Promise.resolve(), failures: 0 };
	const parent = mkdtempSync(join(tmpdir(), "p2-relocate-machines-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const session = directory(parent, "session");
	const phone = directory(parent, "phone");
	const worktree = directory(parent, "worktree");
	const next = directory(parent, "next");
	const w = await worker(t, { cwd: session, env: "laptop" }, { laptop });
	const local = await w.subagent("local", { cwd: phone, env: null });
	const remote = await w.subagent("remote", { cwd: worktree, env: "laptop" });
	const started = Date.now();
	const outputs = await Promise.all(
		[1, local, remote].map(async (id) => run((await w.environment(id)).env, "sleep 0.6; pwd")),
	);
	assert.deepEqual(outputs, [session, phone, worktree]);
	assert(Date.now() - started < 1500, "the commands ran at the same time");
	assert.deepEqual(w.opened, ["laptop"], "both laptop conversations share one connection");
	const [main, other] = await Promise.all([w.environment(1), w.environment(remote)]);
	assert.notEqual(main.env, other.env, "one environment per directory");

	// The session leaves the laptop; the subagent working there keeps its connection.
	await w.relocate({ cwd: next, env: null });
	assert.deepEqual(w.closed, []);
	assert.equal(await run((await w.environment(remote)).env, "pwd"), worktree);
	assert.equal(await run((await w.environment(1)).env, "pwd"), next);
});

// PowerShell follows each agent's machine (Pi Mobile's offerPowerShell, per agent): the main agent and each subagent are
// offered it where they work on Windows and have the shell tool, independently, again after every move.
test("PowerShell is offered to each agent working on Windows, independently", async (t) => {
	const win: Machine = { os: "windows", gate: Promise.resolve(), failures: 0 };
	const parent = mkdtempSync(join(tmpdir(), "p2-relocate-powershell-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const start = directory(parent, "start");
	const windowsDir = directory(parent, "windows");
	const w = await worker(t, { cwd: start, env: null }, { win });
	const there = await w.subagent("there", { cwd: windowsDir, env: "win" });
	const noShell = await w.subagent("no-shell", { cwd: windowsDir, env: "win" }, ["read"]);
	const follower = await w.subagent("follower");
	const local = process.platform === "win32";
	await w.host.root(async (ctx) => {
		const powershell = await ctx.get(PowerShell, {});
		const expect = async (main: boolean) => {
			const offered = await until(
				powershell.offered,
				(value) => value?.["1"] === main && value?.[String(follower)] === main && value?.[String(there)] === true,
			);
			assert.equal(offered?.[String(noShell)], false, "only agents with the shell tool");
			assert.equal(offersPowerShell(await w.agentState(1)), main);
			assert.equal(offersPowerShell(await w.agentState(follower)), main);
			assert.equal(offersPowerShell(await w.agentState(there)), true);
			assert.equal(offersPowerShell(await w.agentState(noShell)), false);
		};
		await expect(local);
		// The session moves to Windows: the main agent and its follower get PowerShell; the others keep theirs.
		await w.relocate({ cwd: windowsDir, env: "win" });
		await expect(true);
		await w.relocate({ cwd: start, env: null });
		await expect(local);
	}, BACKGROUND_CONTEXT);
});
