// The subagents' reporter on its own, its phases called as the scheduler calls them (Astra, rounds 1 and 2): an answer
// or a failure of a subagent whose name was given to a new subagent since reports nothing; a message left queued
// behind a failed run is decided for withdrawal in a commit of its own, and a restart after the withdrawal still
// reports it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { SUBAGENT_TASKS } from "../subagents.ts";

/** The reporter task's phase `name`, as the scheduler calls it. */
function phase(name: "deliver" | "withdraw") {
	const reporter = SUBAGENT_TASKS.tasks?.find((task) => task.definition.name === "harness.subagent-reporter");
	assert.ok(reporter !== undefined);
	// The stand-ins below give only what the phases read.
	return (reporter.definition.phases as Record<string, (...args: unknown[]) => Promise<void>>)[name]!;
}

/** A transaction over a parent whose subagent `reader` is conversation `conversationId`. */
const parentWith = (conversationId: number) => ({
	doc: async () => ({ agents: { reader: { conversationId, reported: [] as number[] } } }),
	entry: async () => ({ model: [] }),
});

describe("a subagent's reporter", () => {
	it("reports nothing for an answer of the previous subagent of the same name", async () => {
		const deliver = phase("deliver");
		const replacement = { conversationId: 3, reported: [] as number[] };
		const submission = { wait: async () => ({ status: "done", type: "input", answer: 42 }) };
		let report: string | undefined;
		await deliver(
			{ id: 9, input: { name: "reader", conversationId: 2, message: "earlier", followUp: false } },
			{
				conversationId: 1,
				conversation: async () => ({ submit: async () => submission, waitForIdle: () => new Promise(() => {}) }),
				commit: async (fn: (tx: unknown) => Promise<{ checkpoint: { report?: string } }>) => {
					const tx = {
						doc: async () => ({ agents: { reader: replacement } }),
						entry: async () => ({ model: [] }),
					};
					report = (await fn(tx)).checkpoint.report;
				},
			},
			context,
		);
		assert.deepEqual(replacement.reported, []);
		assert.equal(report, undefined);
	});

	it("reports nothing for a failure of the previous subagent of the same name (Astra, round 2)", async () => {
		let report: string | undefined = "unset";
		await phase("deliver")(
			{ id: 9, input: { name: "reader", conversationId: 2, message: "first", followUp: false } },
			{
				conversationId: 1,
				conversation: async () => ({
					submit: async () => ({ wait: async () => ({ status: "unanswered", reason: "model_error" }) }),
					waitForIdle: () => new Promise(() => {}),
				}),
				commit: async (fn: (tx: unknown) => Promise<{ checkpoint: { report?: string } }>) => {
					report = (await fn(parentWith(3))).checkpoint.report;
				},
			},
			context,
		);
		assert.equal(report, undefined);
	});

	it("decides a stranded message's withdrawal before withdrawing it, and reports it after a restart (Astra, round 2)", async () => {
		let aborted = false;
		const submission = {
			wait: () => (aborted ? Promise.resolve({ status: "unanswered", reason: "aborted" }) : new Promise(() => {})),
			status: async () => ({ status: aborted ? "unanswered" : "queued" }),
			abort: async () => {
				const before = aborted;
				aborted = true;
				return before ? "settled" : "aborted";
			},
		};
		const checkpoints: unknown[] = [];
		let crash = false;
		const runtime = {
			conversationId: 1,
			conversation: async () => ({ submit: async () => submission, waitForIdle: async () => {} }),
			commit: async (fn: (tx: unknown) => unknown) => {
				if (crash) throw new Error("crashed before the checkpoint");
				checkpoints.push(((await fn(parentWith(2))) as { checkpoint: unknown }).checkpoint);
			},
		};
		const reporter = { id: 9, input: { name: "reader", conversationId: 2, message: "second", followUp: true } };
		await phase("deliver")(reporter, runtime, context);
		// The decision is stored before anything is withdrawn.
		assert.deepEqual([checkpoints, aborted], [[{ phase: "withdraw" }], false]);
		crash = true;
		await assert.rejects(phase("withdraw")(reporter, runtime, context), /crashed/);
		assert.equal(aborted, true);
		// After the restart the phase runs again: the message is withdrawn already, and it is still reported.
		crash = false;
		await phase("withdraw")(reporter, runtime, context);
		assert.match((checkpoints.at(-1) as { report?: string }).report ?? "", /reader failed: its run failed/);
	});
});
