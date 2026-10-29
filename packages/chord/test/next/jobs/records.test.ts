// Tests of a job's records on its object (slice 6a §1.2, §15 rule 5): runs across attempts, cut off by an attempt's
// seal, finished on the next live attempt, and the keep-alive of runs waiting for one.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { untilAborted } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineJob, type JobHandle, type Outcome, type RunningEntry } from "../../../src/next/jobs/index.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { delivered, flushed, instancesOf, memoryStore, rejection, restartable, storeRestartable } from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

const Progress = defineState("app.progress", {
	schema: obj({ output: str() }),
	version: 1,
	initial: () => ({ output: "" }),
});

const Work = defineJob("app.work", { version: 1, args: obj({ text: str() }), result: str(), state: Progress });

type WorkHandle = JobHandle<{ text: string }, string, { output: string }>;

/** What a test's attempts do with a run: `run` waits for its abort (or `release`), `finish` records by attempt. */
async function working(
	finish: (attempt: number, outcome: Outcome<{ text: string }, string, { output: string }>) => void | Promise<void>,
) {
	const jobs: WorkHandle[] = [];
	const object = await restartable(
		objects,
		(attempt, self) => {
			jobs.push(
				self.job(Work, {
					run: async ({ text }, ctx) => {
						await ctx.state.change((draft) => {
							draft.output = `${text} started`;
						}, ctx);
						await untilAborted(ctx);
						return text;
					},
					finish: (outcome) => finish(attempt, outcome),
				}),
			);
		},
		{ closeTimeout: 50 },
	);
	return { ...object, jobs };
}

describe("runs across attempts", () => {
	it("a run cut off by its attempt's seal ends aborted (restart) and is finished on the next live attempt", async () => {
		const finished: string[] = [];
		const { jobs, fail, retry } = await working((attempt, outcome) => {
			finished.push(`${attempt}: ${outcome.kind} ${JSON.stringify(outcome)}`);
		});
		const run = await jobs[0]!.start({ text: "a" }, context);
		await flushed();
		fail();
		await flushed();
		// No live attempt: the run waits, finishing.
		expect(finished).toEqual([]);
		expect((jobs[0]!.running.value as readonly RunningEntry<unknown, unknown>[]).map(({ phase }) => phase)).toEqual([
			"finishing",
		]);
		await retry();
		const outcome = await run.outcome(context);
		expect(outcome).toEqual({
			id: run.id,
			args: { text: "a" },
			state: { output: "a started" },
			kind: "failed",
			error: { kind: "aborted", reason: "restart" },
		});
		expect(finished).toEqual([`2: failed ${JSON.stringify(outcome)}`]);
		expect(jobs[1]!.running.value).toEqual([]);
	});

	it("refuses the cut run's changes made while it stops; its settling records nothing more", async () => {
		const late = Promise.withResolvers<unknown>();
		const jobs: WorkHandle[] = [];
		const { restart } = await restartable(objects, (_, self) => {
			const job = self.job(Work, {
				run: async (_args, ctx) => {
					await untilAborted(ctx);
					// Accepted after an abort (§15), refused once the attempt's seal cut the run off.
					await ctx.state
						.change((draft) => {
							draft.output = "late";
						}, context)
						.then(late.resolve, late.resolve);
					return "done";
				},
			});
			jobs.push(job);
		});
		const run = await jobs[0]!.start({ text: "a" }, context);
		await flushed();
		await restart();
		const outcome = await run.outcome(context);
		expect(await late.promise).toMatchObject({ code: "released" });
		expect(outcome).toMatchObject({ kind: "failed", error: { reason: "restart" }, state: { output: "" } });
		await flushed();
		expect(jobs[1]!.running.value).toEqual([]);
	});

	it("a finish sealed mid-way is not counted as a failure and runs again on the next live attempt", async () => {
		const gate = Promise.withResolvers<void>();
		const attempts: number[] = [];
		const { jobs, restart, errors } = await working(async (attempt) => {
			attempts.push(attempt);
			if (attempt === 1) await gate.promise;
		});
		const run = await jobs[0]!.start({ text: "a" }, context);
		await flushed();
		void jobs[0]!.abort(run.id, context);
		await flushed();
		expect(attempts).toEqual([1]);
		await restart();
		gate.resolve();
		// `run` returns its result after the abort: a success.
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: "a" });
		expect(attempts).toEqual([1, 2]);
		// No job_finish_failed: the stuck finish only outlived the drain.
		expect(errors.map(({ kind }) => kind)).toEqual(["object_failed", "drain_timeout"]);
	});
});

describe("keep-alive", () => {
	it("a run waiting for a live attempt keeps a failed object no longer: it ends with its last reference", async () => {
		const { jobs, fail, reference } = await working(() => {});
		const run = await jobs[0]!.start({ text: "a" }, context);
		await flushed();
		fail();
		reference.release();
		await delivered();
		expect(await rejection(run.outcome(context))).toMatchObject({ code: "released" });
	});
});

describe("the object's end during an admitted commit", () => {
	const Saved = defineState("app.saved", {
		schema: obj({ n: int() }),
		version: 1,
		initial: () => ({ n: 0 }),
		persist: true,
		checkpointWhen: () => false,
	});

	it("a run started in a commit held in the SQL while the host closes ends with the object; no run is left counted", async () => {
		const store = await memoryStore();
		const declared: { saved: SingletonHandle<{ n: number }>; job: WorkHandle }[] = [];
		const { host, attempts } = await storeRestartable(
			objects,
			(_, self) => {
				const job = self.job(Work, {
					run: async (_args, ctx) => {
						await untilAborted(ctx);
						return "";
					},
					finish: () => {},
				});
				declared.push({ saved: self.state(Saved), job });
			},
			{ store },
		);
		const { saved, job } = declared[0]!;
		// The next commit's step waits inside the backend transaction, after its admission.
		const gate = Promise.withResolvers<void>();
		const inStep = Promise.withResolvers<void>();
		const commit = store.commit.bind(store);
		store.commit = (writes, fence, ctx) => {
			const held: StagedWrite = {
				order: "write",
				apply: async () => {
					inStep.resolve();
					await gate.promise;
					return [{ kind: "dropIndex", table: "x", name: "y" }];
				},
			};
			return commit([...writes, held], fence, ctx);
		};
		const started = attempts[0]!.tx(async (tx) => {
			(await tx.draft(saved)).n = 1;
			return tx.start(job, { text: "a" });
		}, context);
		await inStep.promise;
		let closed = false;
		const closing = host.close(context).then(() => {
			closed = true;
		});
		await delivered();
		// The object's teardown waits for the admitted step, so the run's record is adopted before the end.
		expect(closed).toBe(false);
		gate.resolve();
		const run = await started;
		await closing;
		store.commit = commit;
		expect(await rejection(run.outcome(context))).toMatchObject({ code: "released" });
		expect(host.activity.value.jobs).toBe(0);
		expect(store.lastSeq).toBe(1);
		await store.close(context);
	});
});
