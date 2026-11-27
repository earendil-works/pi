// The subagents' reporter (`reporter.ts`) on its own, its phases called as the scheduler calls them, over stand-ins of
// Durable's runtime (Astra, rounds 1 and 2, and rounds 1 and 2 of the port): the message admitted in the commit that
// checks the subagent (the same one, its generation, Use not recorded withheld), nothing reported for a subagent
// replaced, stopped or gone since, the withdrawal reported when Use was withheld; an answer completed before a stop
// kept and reported, and reported once to each sender; a message left queued behind a failed run decided for
// withdrawal in a commit of its own, still reported after a restart, and one that was placed and failed otherwise
// reported as it failed; steer and followUp, with the same request ids after a restart.

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

/** The session's subagent `reader`, conversation `conversationId`, in `generation`. */
function readerOf(conversationId = 2, generation = 0) {
	return {
		conversationId,
		generation,
		reported: [] as number[],
		reportedTo: [] as object[],
		followUps: [] as number[],
	};
}

/**
 * A runtime of conversation `sender` over the session's subagents `agents` (by default `reader`, conversation 2,
 * generation 0), whose subagent answers `submit` with `submission`; `withheld`: the document says Use is withheld;
 * `ended`: the tasks that are terminal.
 */
function runtimeOf(
	submission: object,
	{
		agents = { reader: readerOf() } as Record<string, object>,
		withheld = false,
		idle = false,
		sender = 1,
		ended = [] as number[],
	} = {},
) {
	const seen: Seen = { checkpoints: [], submitted: [], admitted: [] };
	// The tasks each wait parked the reporter on.
	const parked: number[][] = [];
	const roster = { agents, ...(withheld ? { withheld: true } : {}) };
	const tx = {
		doc: async (token: unknown) => (token === Subagents ? roster : {}),
		entry: async () => ({ model: [] }),
		submissionByRequest: async () => (seen.admitted.length > 0 ? { status: "queued" } : undefined),
		// Every task the case names is running, but the ones `ended` lists.
		task: async (id: number) => ({ state: { status: ended.includes(id) ? "terminal" : "running" } }),
	};
	const runtime = {
		conversationId: sender,
		agent: async () => ({ tools: [{ name: "subagent" }] }),
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
			const next = (await fn(tx)) as
				| { status: string; on?: number[]; checkpoint: { phase: string; report?: string } }
				| undefined;
			if (next?.status === "waiting") parked.push(next.on ?? []);
			else if (next !== undefined) seen.checkpoints.push(next.checkpoint);
		},
	};
	return { runtime, seen, roster, parked };
}

/** Resolves once `done` holds, tried at every turn of the event loop. */
async function until(done: () => boolean): Promise<void> {
	while (!done()) await new Promise((resolve) => setImmediate(resolve));
}

/** A reporter with id `id` sending `message` to `reader` in generation 0. */
function reporterOf(id: number, message: string, followUp = false) {
	return { id, input: { name: "reader", conversationId: 2, generation: 0, withholds: 0, message, followUp } };
}

describe("a subagent's reporter", () => {
	it("reports nothing for an answer of the previous subagent of the same name", async () => {
		const settled = Promise.withResolvers<Settled>();
		const { runtime, seen, roster } = runtimeOf({ wait: () => settled.promise });
		const delivered = phase("deliver")(reporterOf(9, "earlier"), runtime, context);
		await until(() => seen.submitted.length === 1);
		// Archived and its name given to a new subagent while the message was answered.
		const replacement = readerOf(3);
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
		roster.agents = { reader: readerOf(3) };
		settled.resolve({ status: "unanswered", reason: "model_error" });
		await delivered;
		assert.deepEqual(seen.checkpoints, [{ phase: "report" }]);
	});

	it("delivers nothing to a subagent stopped or archived since the message was sent, and reports nothing", async () => {
		const { runtime, seen } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			agents: { reader: readerOf(2, 1) },
		});
		await phase("deliver")(reporterOf(9, "before the stop"), runtime, context);
		assert.deepEqual([seen.admitted, seen.submitted, seen.checkpoints], [[], [], [{ phase: "report" }]]);
	});

	it("delivers nothing once Use is recorded withheld; reports the withdrawal (Opus, port round 2)", async () => {
		// The phase's agent still has the subagent tool: the commit's own read of the document decides.
		const { runtime, seen } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			withheld: true,
		});
		await phase("deliver")(reporterOf(9, "after the withhold"), runtime, context);
		assert.deepEqual(seen.admitted, []);
		assert.match(seen.checkpoints[0]?.report ?? "", /reader failed: the message was withdrawn before it ran/);
	});

	it("keeps an answer completed before a stop for `answer`, and reports it (Astra, round 2 of the port)", async () => {
		// Recovery: admitted and answered in generation 0; a stop moved the subagent to generation 1 before the reporter
		// ran again.
		const agent = readerOf(2, 1);
		const { runtime, seen } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			agents: { reader: agent },
		});
		seen.admitted.push({ requestId: "subagent:9:0" });
		await phase("deliver")(reporterOf(9, "done before the stop"), runtime, context);
		assert.deepEqual(agent.reported, [42]);
		assert.match(seen.checkpoints.at(-1)?.report ?? "", /\[subagent reader answered\]/);
	});

	it("reports one answer to each sender whose message it answers, once (Astra, round 2 of the port)", async () => {
		const agent = readerOf();
		const answered = submissionOf({ status: "done", type: "input", answer: 42 });
		const reports = [];
		for (const [id, sender] of [
			[9, 1],
			[10, 5],
			[11, 5],
		] as const) {
			const { runtime, seen } = runtimeOf(answered, { agents: { reader: agent }, sender });
			await phase("deliver")(reporterOf(id, `from ${sender}`), runtime, context);
			reports.push(seen.checkpoints.at(-1)?.report !== undefined);
		}
		assert.deepEqual([reports, agent.reported], [[true, true, false], [42]]);
	});

	it("parks a follow-up on the one sent before it, admits it once that one went (Astra, port round 2)", async () => {
		const agent = { ...readerOf(), followUps: [8, 9] };
		const { runtime, seen, parked } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			agents: { reader: agent },
		});
		await phase("deliver")(reporterOf(9, "second", true), runtime, context);
		assert.deepEqual([parked, seen.admitted.length], [[[8]], 0]);
		// The earlier follow-up was admitted and took itself off; the wait ended, the phase runs again.
		agent.followUps = [9];
		await phase("deliver")(reporterOf(9, "second", true), runtime, context);
		assert.deepEqual([seen.admitted.length, agent.followUps], [1, []]);
	});

	it("is not held back by an earlier follow-up that ended without taking itself off", async () => {
		const agent = { ...readerOf(), followUps: [8, 9] };
		const { runtime, seen } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			agents: { reader: agent },
			ended: [8],
			idle: true,
		});
		await phase("deliver")(reporterOf(9, "second", true), runtime, context);
		assert.deepEqual([seen.admitted.length, agent.followUps], [1, []]);
	});

	it("parks a message sent during a stop on the stopper, admits it after (Astra, port round 3)", async () => {
		const agent = { ...readerOf(), stopping: 40 as number | undefined };
		const { runtime, seen, parked } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }), {
			agents: { reader: agent },
		});
		await phase("deliver")(reporterOf(9, "while stopping"), runtime, context);
		assert.deepEqual([parked, seen.admitted.length], [[[40]], 0]);
		// The stopper ended and cleared its mark.
		agent.stopping = undefined;
		await phase("deliver")(reporterOf(9, "while stopping"), runtime, context);
		assert.equal(seen.admitted.length, 1);
	});

	it("decides a stranded message's withdrawal first, reports it after a restart (Astra, round 2)", async () => {
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

	it("reports a stranded message that was placed and failed as it failed (Astra, port round 1)", async () => {
		const submission = {
			abort: async () => "settled",
			wait: async () => ({ status: "unanswered", reason: "model_error" }),
		};
		const { runtime, seen } = runtimeOf(submission);
		await phase("withdraw")(reporterOf(9, "later", true), runtime, context);
		assert.equal(seen.checkpoints.at(-1)?.report, "[subagent reader failed: model_error]");
	});

	it("steers, or follows up after the current answer; the same request ids after a restart", async () => {
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
				["steer", "subagent:7:0"],
				["followUp", "subagent:8:0"],
				["followUp", "subagent:8:0"],
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

	it("runs a reporter of version 1 on: generation 0, no withhold, its own request id (decision 125)", async () => {
		const reporter = SUBAGENT_TASKS.tasks?.find((task) => task.definition.name === "harness.subagent-reporter");
		const migrate = (reporter?.definition as { migrate?: (i: unknown, c: unknown, v: number) => unknown }).migrate;
		const v1 = { name: "reader", conversationId: 2, message: "old", followUp: false };
		const migrated = migrate?.(v1, { phase: "deliver" }, 1) as { input: object; checkpoint: object };
		assert.deepEqual(migrated, {
			input: { ...v1, generation: 0, withholds: 0, v1: true },
			checkpoint: { phase: "deliver" },
		});
		const { runtime, seen } = runtimeOf(submissionOf({ status: "done", type: "input", answer: 42 }));
		await phase("deliver")({ id: 9, input: migrated.input }, runtime, context);
		assert.equal((seen.admitted[0] as { requestId?: string }).requestId, "subagent:9");
	});
});
