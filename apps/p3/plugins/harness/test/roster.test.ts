// The session's subagents (`roster.ts`) on their own: the stopper's phases, called as the scheduler calls them over a
// stand-in of Durable's runtime (Astra, rounds 2 and 3 of the port). It aborts the subagent's current run only when a
// message of an older generation started it, never work of the stop's own generation; it clears the subagent's mark
// in the commit that ends it, only while the mark is its own; aborted itself, it clears the mark too. A message's
// request id carries its generation. Version 1's per-conversation documents are moved into the session's, once
// (decision 125).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { adoptConversationRosters, requestOf, Stopper, Subagents } from "../roster.ts";

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
