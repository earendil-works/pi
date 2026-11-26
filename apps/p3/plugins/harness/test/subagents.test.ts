// The subagents' reporter on its own (Astra, round 1): an answer of a subagent whose name was given to a new subagent
// since reports nothing and is not recorded on the new one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { SUBAGENT_TASKS } from "../subagents.ts";

describe("a subagent's reporter", () => {
	it("reports nothing for an answer of the previous subagent of the same name", async () => {
		const reporter = SUBAGENT_TASKS.tasks?.find((task) => task.definition.name === "harness.subagent-reporter");
		assert.ok(reporter !== undefined);
		// A phase as the scheduler calls it; the stand-ins give only what the deliver phase reads.
		const deliver = reporter.definition.phases.deliver as (...args: unknown[]) => Promise<void>;
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
});
