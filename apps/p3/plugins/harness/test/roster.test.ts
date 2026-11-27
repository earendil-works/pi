// The session's subagents (`roster.ts`) on their own, over a stand-in of the commits and conversations a stop reads
// (Astra, round 2 of the port): finishing a stop aborts the subagent's current work only when a message of an older
// generation started it, never work sent after the stop's commit, and clears the mark; after a restart, every marked
// stop is finished. A message's request id carries its generation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { LiveDoc } from "@earendil-works/p3/v1/worker";
import { finishStop, finishStops, requestOf, Subagents } from "../roster.ts";

/** A subagent conversation `conversationId` in `generation`, its stop marked unless `stopping` is false. */
function agentOf(conversationId: number, generation: number, stopping = true) {
	return {
		conversationId,
		generation,
		reported: [],
		reportedTo: [],
		followUps: [],
		...(stopping ? { stopping: true as const } : {}),
	};
}

/**
 * A stand-in owner over `agents`, whose conversations each run the inputs `runs` lists (submission ids, whose request
 * ids `requests` gives); records the conversations aborted.
 */
function ownerOf(
	agents: Record<string, ReturnType<typeof agentOf>>,
	runs: Record<number, number[]>,
	requests: Record<number, string>,
) {
	const aborted: number[] = [];
	const roster = { agents };
	const tx = {
		doc: async (token: unknown, id?: number) => {
			if (token === Subagents) return roster;
			assert.equal(token, LiveDoc);
			const inputs = runs[id ?? -1];
			return inputs === undefined ? {} : { run: { inputs } };
		},
		submission: async (id: number) => ({ requestId: requests[id] }),
	};
	const owner = {
		commit: async <T>(change: (tx: never) => T | Promise<T>) => change(tx as never),
		conversation: async (id: number) => ({ abort: async () => void aborted.push(id) }),
	};
	return { owner: owner as never, aborted, roster };
}

describe("a subagent's stop", () => {
	it("aborts work an older generation's message started, then clears the mark", async () => {
		const reader = agentOf(2, 1);
		const { owner, aborted } = ownerOf({ reader }, { 2: [7] }, { 7: requestOf(30, 0) });
		await finishStop(owner, "reader", context);
		assert.deepEqual([aborted, reader.stopping], [[2], undefined]);
	});

	it("leaves work a message of its own generation started, sent after the stop's commit", async () => {
		const reader = agentOf(2, 1);
		const { owner, aborted } = ownerOf({ reader }, { 2: [8] }, { 8: requestOf(31, 1) });
		await finishStop(owner, "reader", context);
		assert.deepEqual([aborted, reader.stopping], [[], undefined]);
	});

	it("finishes every stop a restart cut, and leaves the others", async () => {
		const reader = agentOf(2, 1);
		const writer = agentOf(3, 4, false);
		const { owner, aborted } = ownerOf(
			{ reader, writer },
			{ 2: [7], 3: [9] },
			{ 7: requestOf(30, 0), 9: requestOf(32, 1) },
		);
		await finishStops(owner, context);
		assert.deepEqual([aborted, reader.stopping, writer.stopping], [[2], undefined, undefined]);
	});
});
