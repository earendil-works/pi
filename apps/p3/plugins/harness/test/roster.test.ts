// The session's subagents (`roster.ts`) on their own: the stopper's phases, called as the scheduler calls them over a
// stand-in of Durable's runtime (Astra, rounds 2 and 3 of the port). It aborts the subagent's current run only when a
// message of an older generation started it, never work of the stop's own generation; it clears the subagent's mark
// in the commit that ends it, only while the mark is its own; aborted itself, it clears the mark too. A message's
// request id carries its generation. Version 1's per-conversation documents are moved into the session's, once
// (decision 125): on its own, and on a worker whose store holds what main at 7093618af wrote (two top-level
// conversations listing one name each, a reported answer, a reporter of version 1 in flight).

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, contribute, defineFacet, until } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	createModels,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	type EntryId,
	fauxAssistantMessage,
	Harness,
	SessionHarness,
	StoreStorage,
	WorkerRuntime,
} from "@earendil-works/p3/v1/worker";
import { eventually, within } from "../../../test/until.ts";
import { Anchor, adoptConversationRosters, requestOf, Stopper, Subagents } from "../roster.ts";
import { login, says, sessionRow, standIns, subagents } from "./stubs.ts";

/** The stopper's phase `name`, or its abort handler, as the scheduler calls them. */
function phase(name: "decide" | "abort" | "clear" | "aborted") {
	const definition = Stopper.definition as unknown as {
		phases: Record<string, (...args: unknown[]) => Promise<void>>;
		abort: (...args: unknown[]) => Promise<void>;
	};
	return name === "aborted" ? definition.abort : definition.phases[name]!;
}

/** A subagent conversation 2 in generation 1, its stop marked by stopper `stopping`. */
function agentOf(stopping: number) {
	return { conversationId: 2, generation: 1, reported: [], reportedTo: [], followUps: [], stopping };
}

/**
 * A runtime over the subagent `agent`, whose conversation runs `inputs` (submission ids, whose request ids `requests`
 * gives); records the next states and the conversations aborted.
 */
function runtimeOf(agent: object, inputs: number[] = [], requests: Record<number, string> = {}) {
	const states: { status: string; checkpoint?: { phase: string } }[] = [];
	const aborted: number[] = [];
	const tx = {
		doc: async (token: unknown) => (token === Subagents ? { agents: { reader: agent } } : { run: { inputs } }),
		submission: async (id: number) => ({ requestId: requests[id] }),
	};
	const runtime = {
		commit: async (fn: (tx: unknown) => unknown) => {
			states.push((await fn(tx)) as (typeof states)[number]);
		},
		conversation: async (id: number) => ({ abort: async () => void aborted.push(id) }),
	};
	return { runtime, states, aborted };
}

/** Stopper `id` of the subagent `reader`, conversation 2. */
function stopperOf(id: number) {
	return { id, input: { name: "reader", conversationId: 2 } };
}

describe("a subagent's stopper", () => {
	it("goes on to the abort when a message of an older generation started the current run", async () => {
		const { runtime, states } = runtimeOf(agentOf(5), [7], { 7: requestOf(30, 0) });
		await phase("decide")(stopperOf(5), runtime, context);
		assert.deepEqual(states, [{ status: "running", checkpoint: { phase: "abort" } }]);
	});

	it("aborts nothing of the stop's own generation: work sent after the stop's commit", async () => {
		const { runtime, states, aborted } = runtimeOf(agentOf(5), [8], { 8: requestOf(31, 1) });
		await phase("decide")(stopperOf(5), runtime, context);
		assert.deepEqual([states, aborted], [[{ status: "running", checkpoint: { phase: "clear" } }], []]);
	});

	it("decides by the subagent's current generation: a stop that reused it makes the first stop's work older (Astra, port 5)", async () => {
		const agent = { ...agentOf(5), generation: 2 };
		const { runtime, states } = runtimeOf(agent, [8], { 8: requestOf(31, 1) });
		await phase("decide")(stopperOf(5), runtime, context);
		assert.deepEqual(states, [{ status: "running", checkpoint: { phase: "abort" } }]);
	});

	it("aborts the subagent's conversation, then goes on to clear", async () => {
		const { runtime, states, aborted } = runtimeOf(agentOf(5));
		await phase("abort")(stopperOf(5), runtime, context);
		assert.deepEqual([aborted, states], [[2], [{ status: "running", checkpoint: { phase: "clear" } }]]);
	});

	it("clears its own mark as it ends, and leaves a later stop's", async () => {
		const own = agentOf(5);
		const { runtime, states } = runtimeOf(own);
		await phase("clear")(stopperOf(5), runtime, context);
		const later = agentOf(6);
		await phase("clear")(stopperOf(5), runtimeOf(later).runtime, context);
		assert.deepEqual([own.stopping, later.stopping, states[0]?.status], [undefined, 6, "terminal"]);
	});

	it("clears its mark when it is aborted itself, so the messages held back for it go on", async () => {
		const agent = agentOf(5);
		await phase("aborted")(stopperOf(5), runtimeOf(agent).runtime, context);
		assert.equal(agent.stopping, undefined);
	});
});

describe("the move of version 1's documents", () => {
	/**
	 * A stand-in harness whose conversations are `conversations` (owned by a task when `owner` is set), with version 1
	 * documents `v1` by conversation and the session's document `session` (none yet: `undefined`).
	 */
	function durableOf(
		conversations: { id: number; owner?: object }[],
		v1: Record<number, object>,
		session?: { agents: Record<string, object> },
	) {
		const written = { agents: {} as Record<string, unknown> };
		const durable = {
			snapshot: async (token: { definition: { scope: string } }, id?: number) =>
				token.definition.scope === "session" ? session : v1[id ?? -1] && { agents: v1[id ?? -1] },
			commit: async (change: (tx: unknown) => unknown) =>
				change({
					scanConversations: async () => ({ items: conversations }),
					doc: async () => written,
				}),
			conversation: async () => ({
				agent: async () => ({ model: { provider: "faux", modelId: "faux-model" }, thinkingLevel: "low" }),
			}),
		};
		return { durable: durable as never, written };
	}

	it("moves each conversation's subagents into the session's document, a name taken twice made unique", async () => {
		const { durable, written } = durableOf([{ id: 1 }, { id: 5, owner: { taskId: 2 } }, { id: 7 }], {
			1: { reader: { conversationId: 5, reported: [3] } },
			7: { reader: { conversationId: 9, reported: [] } },
		});
		await adoptConversationRosters(durable, context);
		const common = { model: "faux/faux-model", thinkingLevel: "low", generation: 0, followUps: [] };
		assert.deepEqual(written.agents, {
			reader: { conversationId: 5, reported: [3], reportedTo: [{ answer: 3, to: 1 }], ...common },
			"reader-9": { conversationId: 9, reported: [], reportedTo: [], ...common },
		});
	});

	it("moves nothing once the session's document exists", async () => {
		const { durable, written } = durableOf(
			[{ id: 1 }],
			{ 1: { reader: { conversationId: 5, reported: [] } } },
			{
				agents: {},
			},
		);
		await adoptConversationRosters(durable, context);
		assert.deepEqual(written.agents, {});
	});
});

/** Version 1 of the subagents' document, as main at 7093618af defined it: each conversation's subagents. */
const SubagentsV1 = defineDoc<{ agents: Record<string, { conversationId: ConversationId; reported: EntryId[] }> }>({
	checkpointWhen: () => false,
	kind: "harness.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

/** Version 1 of the reporter, as main at 7093618af stored it: its name, version, input and first phase (never run here). */
const ReporterV1 = defineTask<
	{ name: string; conversationId: ConversationId; message: string; followUp: boolean },
	{ phase: "deliver" },
	null
>({
	name: "harness.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: { deliver: async () => {} },
	abort: async () => {},
});

/** What the case wrote: the two subagents' conversations and the answer reported. */
type Written = { readonly first: ConversationId; readonly second: ConversationId; readonly answer: EntryId };

/**
 * Writes into the worker's store what main at 7093618af left: the root conversation and another top-level one, each
 * listing a subagent `reader` in its version 1 document, the root's with one reported answer, and a reporter of version
 * 1 in flight (created, not run) with a message to the root's `reader`. Durable is opened on the store paused, closed
 * before the harness opens.
 */
async function writeV1(store: WorkerRuntime["store"], ctx: typeof context): Promise<Written> {
	const storage = await StoreStorage.open(store, "harness", ctx);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "harness.subagent-tasks", tasks: [Anchor, ReporterV1] }));
	const durable = await Harness.open(storage, { models: createModels(), registry }, ctx);
	try {
		const root = await durable.root(ctx);
		return await durable.commit(async (tx) => {
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			// The agent's model, as the harness's first submit gave it.
			await configure(tx, root.id, { model: { provider: "faux", modelId: "faux-model" } });
			const branch = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const child = async (parent: ConversationId) => {
				const anchor = await tx.createTask(Anchor, null, { ...background, conversationId: parent });
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-model" } });
				return created.id;
			};
			const first = await child(root.id);
			const second = await child(branch.id);
			const answer = await tx.appendEntry(AssistantEntry, first, {
				model: [fauxAssistantMessage("an earlier answer")],
			});
			(await tx.doc(SubagentsV1, root.id)).agents.reader = { conversationId: first, reported: [answer.id] };
			(await tx.doc(SubagentsV1, branch.id)).agents.reader = { conversationId: second, reported: [] };
			const input = { name: "reader", conversationId: first, message: "in flight", followUp: false };
			await tx.createTask(ReporterV1, input, { ...background, conversationId: root.id });
			return { first, second, answer: answer.id };
		}, ctx);
	} finally {
		await durable.close(ctx);
	}
}

describe("a worker whose store version 1 of the subagents wrote", () => {
	it("moves both subagents into the session's document and delivers the message in flight once (decision 125)", async () => {
		const folder = await realpath(await mkdtemp(join(tmpdir(), "p3-roster-")));
		const written = Promise.withResolvers<Written>();
		const facts = written.promise.then(() => {});
		// Writes the store before the session's row is served, so the harness opens on it only then.
		const v1 = defineFacet((host) => {
			contribute(host, "test.v1", (self) => {
				const runtime = self.registry(WorkerRuntime);
				self.open(
					async (ctx) => {
						written.resolve(await writeV1(runtime.value.store, ctx));
						return null;
					},
					() => {},
				);
			});
		});
		const script = [says("in flight", "handled"), says("", "ok")];
		const { stubs, server, control } = standIns(
			sessionRow("s1", folder),
			[login("l", "faux", script), subagents()],
			[],
			{
				facts,
			},
		);
		const t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{ kind: "worker", session: "s1", stubs: [{ name: "test.v1", facet: v1 }, ...stubs], server },
			context,
		);
		try {
			const { first, second, answer } = await written.promise;
			const open = await until(
				await t.host.registry(SessionHarness, context),
				(value) => value !== undefined,
				within("the harness", context, 10_000),
			);
			assert.ok(open !== undefined);
			await eventually(
				() => control.requests.filter(({ last }) => last === "[subagent reader answered] handled").length,
				(count) => count === 1,
				10_000,
			);
			await open.durable.waitForIdle(context);
			const roster = (await open.durable.snapshot(Subagents, context))?.agents ?? {};
			assert.deepEqual(Object.keys(roster), ["reader", `reader-${second}`]);
			const [reader, other] = [roster.reader, roster[`reader-${second}`]];
			// The earlier answer kept, the one to the message in flight added.
			assert.deepEqual([reader?.conversationId, reader?.reported[0], reader?.reported.length], [first, answer, 2]);
			assert.deepEqual(reader?.reportedTo[0], { answer, to: 1 });
			assert.deepEqual([other?.conversationId, other?.reported], [second, []]);
			// The message in flight reached the subagent once, and its answer came back once.
			assert.equal(control.requests.filter(({ last }) => last === "in flight").length, 1);
		} finally {
			await t.close(context);
			await rm(folder, { recursive: true, force: true });
		}
	});
});
