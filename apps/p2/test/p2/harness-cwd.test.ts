// The Harness moves the root and the conversations following the session's cwd (Pi Mobile 78056b34e) in the same start,
// before it is live, with the followers its plugin's placement lists. The same start places own cwds a version 1
// registry stored without their environment.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type ConversationId,
	configure,
	createRegistry,
	Harness as DurableHarness,
	defineDoc,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { createP2Models } from "../../plugins/models/models.ts";
import { Subagents as Registry } from "../../plugins/subagents/contract.worker.ts";
import { ownLocation, placeSubagents, spawnEnvironments } from "../../plugins/subagents/tools.ts";
import { createHost, defineFacet, Session } from "../../src/runtime/chord.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { openHostStore, sessionDirectory } from "../../src/runtime/host-dirs.ts";
import { HOST } from "../../src/runtime/principals.ts";
import { openSessionStorage } from "../../src/runtime/session-store.ts";
import {
	ConversationLocations,
	type ConversationPlacement,
	HarnessConfig,
	HarnessHost,
	HarnessNative,
	Liveness,
	SessionLocation,
	type WorkerInit,
	workerCore,
} from "../../src/runtime/worker.ts";
import { APP, NO_IMAGES } from "./helpers.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };
const context = durableContext(new AbortController().signal);

/** The registry as version 1 stored it: an own cwd without its environment. */
type AgentV1 = { conversationId: ConversationId; model: string; thinkingLevel: string; tools: string[]; cwd?: string };
const RegistryV1 = defineDoc<{
	agents: Record<string, AgentV1 & { reported: number[] }>;
	reporters: Record<string, string>;
	oneShots?: Record<
		string,
		{ conversationId: ConversationId; label: string; model: string; thinkingLevel: string; tools: string[] }
	>;
}>({
	kind: "p2.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {}, reporters: {} }),
	checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/**
 * A session whose conversations hold stale cwds: the root, a subagent and a one-shot agent; two with their own cwd,
 * stored by version 1 (without the environment).
 */
async function seed(dataDir: string, own: string) {
	const session = await openSessionStorage(dataDir, "s1", context);
	const durable = await DurableHarness.open(
		session.storage,
		{ models: createP2Models(true), registry: createRegistry() },
		context,
	);
	try {
		const root = await durable.root(context, { agent: { model: MODEL, cwd: "/elsewhere/root" } });
		const child = async (cwd: string) => {
			const conversation = await durable.createConversation({ ownership: { kind: "ownerless" } }, context);
			await durable.commit((tx) => configure(tx, conversation.id, { model: MODEL, cwd }), context);
			return conversation.id;
		};
		const ids = {
			follow: await child("/elsewhere/follow"),
			own: await child(own),
			recorded: await child(own),
			agent: await child("/elsewhere/agent"),
		};
		const agent = { model: "faux/faux-1", thinkingLevel: "off", tools: [] };
		await durable.commit(async (tx) => {
			const registry = await tx.doc(RegistryV1, root.id);
			registry.agents.follow = { conversationId: ids.follow, ...agent, reported: [] };
			registry.agents.own = { conversationId: ids.own, ...agent, cwd: own, reported: [] };
			registry.agents.recorded = { conversationId: ids.recorded, ...agent, cwd: own, reported: [] };
			registry.oneShots = { "call/c1": { conversationId: ids.agent, label: "check", ...agent } };
		}, context);
		return { root: root.id, ...ids };
	} finally {
		await durable.close(context);
		await session.close();
	}
}

const models = defineFacet((_host, self) =>
	self.contribute(HarnessConfig, { default: { models: () => createP2Models(true), settings: () => ({}) } }),
);

/**
 * The subagents plugin's placement (as its worker facet contributes it): `recorded` is what the server recorded (the
 * worker init value `subagentLocations`), the session's spawn environment is `gpu`. `opened` hears its first use.
 */
const followers = (opened: string[], recorded: unknown) =>
	defineFacet((_host, self) =>
		self.contribute(ConversationLocations, {
			subagents: {
				place: (harness, _session, _values, context) => {
					opened.push("followers");
					return placeSubagents(harness, spawnEnvironments(recorded, "gpu"), context);
				},
				own: ownLocation,
			} satisfies ConversationPlacement,
		}),
	);

/** A session host with the worker's core over `dataDir`, its Harness open (`HarnessHost` held). */
async function start(dataDir: string, project: string, facets: { followers?: ReturnType<typeof followers> }) {
	const store = await openHostStore(sessionDirectory(dataDir, "s1"), { outbox: false }, BACKGROUND_CONTEXT);
	const host = createHost({
		address: Session({ id: "s1" }),
		principal: HOST,
		store,
		onError: (error) => console.error(error),
	});
	const init: WorkerInit = {
		app: APP,
		dataDir,
		fake: true,
		telemetry: false,
		generation: 1,
		values: { session: { id: "s1", cwd: project, env: null, model: MODEL, thinkingLevel: "off" } },
	};
	const location = new SessionLocation({ cwd: project, env: null });
	const core = workerCore(
		init,
		new Liveness(),
		location,
		store,
		(fn) => host.root(fn, BACKGROUND_CONTEXT),
		NO_IMAGES,
		undefined,
	);
	await host.load(
		[
			{ name: "@p2/core", facet: core },
			{ name: "models", facet: models },
			...(facets.followers ? [{ name: "subagents", facet: facets.followers }] : []),
		],
		BACKGROUND_CONTEXT,
	);
	const holder = host.hold(HarnessHost, {}, BACKGROUND_CONTEXT);
	await whenLive(holder);
	const parts = (await host.registry(HarnessNative, BACKGROUND_CONTEXT)).value!;
	const harness = { durable: parts.durable, environments: parts.environments, release: () => holder.release() };
	const cwd = async (id: ConversationId) =>
		(await (await parts.durable.conversation(id, context))?.agent(context))?.cwd;
	return { host, store, harness, cwd };
}

test("the Harness moves the session's cwd followers before it is live", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-harness-cwd-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const project = join(directory, "project");
	const own = join(directory, "own");
	mkdirSync(project);
	mkdirSync(own);
	const ids = await seed(join(directory, "data"), own);
	const opened: string[] = [];
	const recorded = { [String(ids.recorded)]: { cwd: own, env: "laptop" } };
	const { host, store, harness, cwd } = await start(join(directory, "data"), project, {
		followers: followers(opened, recorded),
	});
	try {
		assert.deepEqual(opened, ["followers"], "the provider was consulted while the Harness opened");
		assert.equal(await cwd(ids.root), project);
		assert.equal(await cwd(ids.follow), project);
		assert.equal(await cwd(ids.agent), project, "one-shot agents follow too");
		assert.equal(await cwd(ids.own), own, "a subagent spawned with its own cwd keeps it");
		// Version 1 own cwds are placed before the Harness is live: on the environment the server recorded, else on the
		// session's spawn environment. A subagent without its own cwd keeps following.
		const registry = await harness.durable.snapshot(Registry, ROOT_CONVERSATION_ID, context);
		assert.deepEqual(registry?.agents.own?.location, { cwd: own, env: "gpu" });
		assert.equal(registry?.agents.own?.unplacedCwd, undefined);
		assert.deepEqual(registry?.agents.recorded?.location, { cwd: own, env: "laptop" });
		assert.equal(registry?.agents.follow?.location, undefined);
		const environments = harness.environments;
		assert.deepEqual(await environments.locate(ids.own, context), { cwd: own, env: "gpu" });
		assert.deepEqual(await environments.locate(ids.follow, context), { cwd: project, env: null });
		assert.deepEqual(await environments.locate(ids.agent, context), { cwd: project, env: null });
	} finally {
		harness.release();
		await host.close(BACKGROUND_CONTEXT);
		await store.close(BACKGROUND_CONTEXT);
	}
});

test("without a followers provider the Harness still opens and moves only the root", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-harness-cwd-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const project = join(directory, "project");
	mkdirSync(project);
	const ids = await seed(join(directory, "data"), join(directory, "own"));
	const { host, store, harness, cwd } = await start(join(directory, "data"), project, {});
	try {
		assert.equal(await cwd(ids.root), project);
		assert.equal(await cwd(ids.follow), "/elsewhere/follow");
	} finally {
		harness.release();
		await host.close(BACKGROUND_CONTEXT);
		await store.close(BACKGROUND_CONTEXT);
	}
});
