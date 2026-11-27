// The subagents' reporter (`reporter.ts`) on its own, its phases called as the scheduler calls them, over stand-ins of
// Durable's runtime (Astra, rounds 1 and 2, and round 1 of the port): the message admitted in the commit that checks
// the subagent (the same one, its generation, the agent still with the `subagent` tool), nothing reported for a
// subagent replaced, stopped or gone since, the withdrawal reported when Use was withheld; a message left queued behind
// a failed run decided for withdrawal in a commit of its own, still reported after a restart, and one that was placed
// and failed otherwise reported as it failed; steer and followUp, with the same request ids after a restart.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { SUBAGENT_TASKS } from "../reporter.ts";
import { Subagents } from "../roster.ts";

/** The reporter task's phase `name`, as the scheduler calls it. */
function phase(name: "deliver" | "withdraw") {
	const reporter = SUBAGENT_TASKS.tasks?.find((task) => task.definition.name === "harness.subagent-reporter");
	assert.ok(reporter !== undefined);
	// The stand-ins below give only what the phases read.
	return (reporter.definition.phases as Record<string, (...args: unknown[]) => Promise<void>>)[name]!;
}

/** A settled submission, as `wait` answers it. */
type Settled = { status: string; type?: string; answer?: number; reason?: string };

/** A submission that settles as `settled` (never, without one). */
function submissionOf(settled?: Settled) {
	return { wait: () => (settled === undefined ? new Promise(() => {}) : Promise.resolve(settled)) };
}

/** What a case's stand-ins saw: the next states committed, the drafts submitted and admitted. */
type Seen = { checkpoints: { phase: string; report?: string }[]; submitted: unknown[]; admitted: unknown[] };

/**
 * A runtime over the session's subagents `agents` (by default `reader`, conversation 2, generation 0), whose subagent
 * answers `submit` with `submission`; `subagentTool: false`: the agent no longer has the `subagent` tool.
 */
function runtimeOf(
	submission: object,
	{
		agents = { reader: { conversationId: 2, generation: 0, reported: [] as number[] } } as Record<string, object>,
		subagentTool = true,
		idle = false,
	} = {},
) {
	const seen: Seen = { checkpoints: [], submitted: [], admitted: [] };
	const roster = { agents };
	const tx = {
		doc: async (token: unknown) => (token === Subagents ? roster : {}),
		entry: async () => ({ model: [] }),
		submissionByRequest: async () => (seen.admitted.length > 0 ? { status: "queued" } : undefined),
	};
	const runtime = {
		conversationId: 1,
		agent: async () => ({ tools: subagentTool ? [{ name: "subagent" }] : [] }),
		conversation: async () => ({
			id: 2,
			admit: async (_tx: unknown, draft: unknown) => seen.admitted.push(draft),
			submit: async (draft: unknown) => {
				seen.submitted.push(draft);
				return submission;
			},
			waitForIdle: () => (idle ? Promise.resolve() : new Promise(() => {})),
		}),
		commit: async (fn: (tx: unknown) => unknown) => {
			const next = (await fn(tx)) as { checkpoint: { phase: string; report?: string } } | undefined;
			if (next !== undefined) seen.checkpoints.push(next.checkpoint);
		},
	};
	return { runtime, seen, roster };
}

/** Resolves once `done` holds, tried at every turn of the event loop. */
async function until(done: () => boolean): Promise<void> {
	while (!done()) await new Promise((resolve) => setImmediate(resolve));
}

/** A reporter with id `id` sending `message` to `reader` in generation 0. */
function reporterOf(id: number, message: string, followUp = false) {
	return { id, input: { name: "reader", conversationId: 2, generation: 0, message, followUp } };
}

describe("a subagent's reporter", () => {
	it("reports nothing for an answer of the previous subagent of the same name", async () => {
		const settled = Promise.withResolvers<Settled>();
		const { runtime, seen, roster } = runtimeOf({ wait: () => settled.promise });
		const delivered = phase("deliver")(reporterOf(9, "earlier"), runtime, context);
		await until(() => seen.submitted.length === 1);
		// Archived and its name given to a new subagent while the message was answered.
		const replacement = { conversationId: 3, generation: 0, reported: [] as number[] };
		roster.agents = { reader: replacement };
		settled.resolve({ status: "done", type: "input", answer: 42 });
		await delivered;
		assert.deepEqual([replacement.reported, seen.checkpoints], [[], [{ phase: "report" }]]);
	});

	it("reports nothing for a failure of the previous subagent of the same name (Astra, round 2)", async () => {
		const settled = Promise.withResolvers<Settled>();
		const { runtime, seen, roster } = runtimeOf({ wait: () => settled.promise });
		const delivered = phase("deliver")(reporterOf(9, "first"), runtime, context);
		await until(() => seen.submitted.length === 1);
		roster.agents = { reader: { conversationId: 3, generation: 0, reported: [] } };
		settled.resolve({ status: "unanswered", reason: "model_error" });
		await delivered;
		assert.deepEqual(seen.checkpoints, [{ phase: "report" }]);
	});

	it("delivers nothing to a subagent stopped or archived since the message was sent, and reports nothing", async () => {
		const { runtime, seen } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			agents: { reader: { conversationId: 2, generation: 1, reported: [] } },
		});
		await phase("deliver")(reporterOf(9, "before the stop"), runtime, context);
		assert.deepEqual([seen.admitted, seen.submitted, seen.checkpoints], [[], [], [{ phase: "report" }]]);
	});

	it("delivers nothing once the agent no longer has the subagent tool, and reports the withdrawal", async () => {
		// Answered at once if it were delivered: the case ends either way.
		const { runtime, seen } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			subagentTool: false,
		});
		await phase("deliver")(reporterOf(9, "after the withhold"), runtime, context);
		assert.deepEqual(seen.admitted, []);
		assert.match(seen.checkpoints[0]?.report ?? "", /reader failed: the message was withdrawn before it ran/);
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
		const { runtime, seen } = runtimeOf(submission, { idle: true });
		let crash = false;
		const commit = runtime.commit;
		runtime.commit = async (fn) => {
			if (crash) throw new Error("crashed before the checkpoint");
			await commit(fn);
		};
		const reporter = reporterOf(9, "second", true);
		await phase("deliver")(reporter, runtime, context);
		// The decision is stored before anything is withdrawn.
		assert.deepEqual([seen.checkpoints, aborted], [[{ phase: "withdraw" }], false]);
		crash = true;
		await assert.rejects(phase("withdraw")(reporter, runtime, context), /crashed/);
		assert.equal(aborted, true);
		// After the restart the phase runs again: the message is withdrawn already, and it is still reported.
		crash = false;
		await phase("withdraw")(reporter, runtime, context);
		assert.match(seen.checkpoints.at(-1)?.report ?? "", /reader failed: its run failed/);
	});

	it("reports a formerly stranded message placed and failed before the withdrawal as it failed (Astra, round 1 of the port)", async () => {
		const submission = {
			abort: async () => "settled",
			wait: async () => ({ status: "unanswered", reason: "model_error" }),
		};
		const { runtime, seen } = runtimeOf(submission);
		await phase("withdraw")(reporterOf(9, "later", true), runtime, context);
		assert.equal(seen.checkpoints.at(-1)?.report, "[subagent reader failed: model_error]");
	});

	it("steers a busy subagent, or waits for its current answer with followUp; the same request ids after a restart", async () => {
		const { runtime, seen } = runtimeOf(submissionOf({ status: "unanswered", reason: "aborted" }));
		await phase("deliver")(reporterOf(7, "now"), runtime, context);
		await phase("deliver")(reporterOf(8, "later", true), runtime, context);
		// After a restart the phase runs again with the same request id: Durable answers with the first submission.
		await phase("deliver")(reporterOf(8, "later", true), runtime, context);
		assert.deepEqual(
			(seen.submitted as { whenBusy: string; requestId: string }[]).map(({ whenBusy, requestId }) => [
				whenBusy,
				requestId,
			]),
			[
				["steer", "subagent:7"],
				["followUp", "subagent:8"],
				["followUp", "subagent:8"],
			],
		);
	});

	it("reports nothing and records nothing for an answer of a subagent the document no longer has", async () => {
		const { runtime, seen, roster } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }));
		await phase("deliver")(reporterOf(9, "task"), runtime, context);
		roster.agents = {};
		await phase("deliver")(reporterOf(9, "task"), runtime, context);
		assert.deepEqual([seen.checkpoints.at(-1), roster.agents], [{ phase: "report" }, {}]);
	});
});
