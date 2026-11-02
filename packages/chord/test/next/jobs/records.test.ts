// Tests of a job's records on its object (slice 6a §1.2, §15 rule 5): runs across attempts, cut off by an attempt's
// seal, finished on the next live attempt, and the keep-alive of runs waiting for one.

import { describe, expect, it } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, str, unknown } from "../../../src/next/contracts/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, untilAborted } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineJob, type JobHandle, type Outcome, type RunningEntry } from "../../../src/next/jobs/index.ts";
import { constant } from "../../../src/next/state/index.ts";
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

/** The jobs object of the reload tests: `start` starts a run of `text`, `running` lists them. */
const Runner = local("app.runner", {
	version: 1,
	params: {},
	members: { start: method(obj({ text: str() }), str()), running: arr(unknown()) },
});

/** Version 2 of `Work`: its args gained a priority, its result is an object; v1 runs map forwards. */
const WorkV2 = defineJob("app.work", {
	version: 2,
	args: obj({ text: str(), priority: int() }),
	result: obj({ text: str() }),
	state: Progress,
	accepts: {
		1: { args: (old: { text: string }) => ({ ...old, priority: 0 }), result: (old: string) => ({ text: old }) },
	},
});

/** `WorkV2` without an adapter for version 1. */
const WorkV2Strict = defineJob("app.work", {
	version: 2,
	args: obj({ text: str(), priority: int() }),
	result: obj({ text: str() }),
	state: Progress,
});

type Finished = { readonly code: string; readonly outcome: unknown };

/**
 * A facet serving `Runner` with `job` (labelled `code` in what its finish records into `finished`); its `run` waits for
 * `gates.shift()` when one is queued; with `native` the object opens a native (a reload restarts it).
 */
function runner(
	code: string,
	job: typeof Work | typeof WorkV2 | typeof WorkV2Strict | undefined,
	finished: Finished[],
	options: { readonly gates?: Promise<void>[]; readonly native?: boolean } = {},
) {
	return defineFacet((h) =>
		h.serve(Runner, (_, self) => {
			if (options.native)
				self.open(
					async () => code,
					() => {},
				);
			if (job === undefined) return { start: async () => "", running: constant([]) };
			const handle = (
				self.job as (definition: unknown, implementation: unknown) => JobHandle<never, unknown, never>
			)(job, {
				run: async (args: { text: string }, ctx: { readonly abortSignal?: AbortSignal }) => {
					const gate = options.gates?.shift();
					if (gate !== undefined) await Promise.race([gate, untilAborted(ctx as never)]);
					ctx.abortSignal?.throwIfAborted();
					return job.version === 1 ? `${args.text} by ${code}` : { text: `${args.text} by ${code}` };
				},
				finish: (outcome: unknown) => void finished.push({ code, outcome }),
			});
			return {
				start: async ({ text }: { text: string }, ctx: Context) =>
					(await handle.start((job.version === 1 ? { text } : { text, priority: 1 }) as never, ctx)).id,
				running: handle.running as never,
			};
		}),
	);
}

describe("jobs across a reload (slice 7b §8)", () => {
	it("an older run finishes on its old code across a swap; its finish runs on the new code, mapped forwards once", async () => {
		const finished: Finished[] = [];
		const gate = Promise.withResolvers<void>();
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: runner("v1", Work, finished, { gates: [gate.promise] }) }], context);
		const jobs = await host.get(Runner, {}, context);
		await jobs.start({ text: "a" }, context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: runner("v2", WorkV2, finished) }], context);
		await flushed();
		// Listed with its args mapped forwards.
		expect(jobs.running.value).toMatchObject([{ version: 1, args: { text: "a", priority: 0 }, phase: "running" }]);
		gate.resolve();
		await flushed();
		expect(finished).toEqual([
			{
				code: "v2",
				outcome: expect.objectContaining({
					kind: "done",
					args: { text: "a", priority: 0 },
					result: { text: "a by v1" },
				}),
			},
		]);
		await host.close(context);
	});

	it("a run without an adapter is blocked (version) until a reload brings matching code", async () => {
		const finished: Finished[] = [];
		const gate = Promise.withResolvers<void>();
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: runner("v1", Work, finished, { gates: [gate.promise] }) }], context);
		const jobs = await host.get(Runner, {}, context);
		const id = await jobs.start({ text: "a" }, context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: runner("v2", WorkV2Strict, finished) }], context);
		gate.resolve();
		await flushed();
		expect(jobs.running.value).toEqual([{ id, version: 1, phase: "blocked", reason: "version" }]);
		expect(finished).toEqual([]);
		await host.reload([{ name: "@test/app", facet: runner("v1b", Work, finished) }], context);
		await flushed();
		expect(finished).toEqual([
			{ code: "v1b", outcome: expect.objectContaining({ kind: "done", result: "a by v1" }) },
		]);
		expect(jobs.running.value).toEqual([]);
		await host.close(context);
	});

	it("a native restart aborts running in-memory runs (reload); their finish runs on the new code", async () => {
		const finished: Finished[] = [];
		const host = createHost({ onError: () => {} });
		const gate = Promise.withResolvers<void>();
		await host.load(
			[{ name: "@test/app", facet: runner("v1", Work, finished, { gates: [gate.promise], native: true }) }],
			context,
		);
		const jobs = await host.get(Runner, {}, context);
		await jobs.start({ text: "a" }, context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: runner("v2", Work, finished, { native: true }) }], context);
		await flushed();
		expect(finished).toEqual([
			{
				code: "v2",
				outcome: expect.objectContaining({ kind: "failed", error: { kind: "aborted", reason: "reload" } }),
			},
		]);
		await host.close(context);
	});

	it("a job the new code no longer declares blocks its runs (version); declared again, they go on", async () => {
		const finished: Finished[] = [];
		const gate = Promise.withResolvers<void>();
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: runner("v1", Work, finished, { gates: [gate.promise] }) }], context);
		const jobs = await host.get(Runner, {}, context);
		await jobs.start({ text: "a" }, context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: runner("v2", undefined, finished) }], context);
		gate.resolve();
		await flushed();
		expect(finished).toEqual([]);
		await host.reload([{ name: "@test/app", facet: runner("v3", Work, finished) }], context);
		await flushed();
		expect(finished).toEqual([{ code: "v3", outcome: expect.objectContaining({ kind: "done", result: "a by v1" }) }]);
		await host.close(context);
	});
});

describe("a reservation released after a swap (final review)", () => {
	it("starts the old code's run with its own args, not the new version's mapping (Sol)", async () => {
		const Owner = local("app.reserve-owner", { version: 1, params: {}, members: {} });
		const V1 = defineJob("app.reserve", {
			version: 1,
			args: obj({ n: int() }),
			result: int(),
			persist: { resume: "rerun" },
		});
		const V2 = defineJob("app.reserve", {
			version: 2,
			args: obj({ label: str() }),
			result: int(),
			persist: { resume: "rerun" },
			accepts: { 1: { args: (old: { n: number }) => ({ label: `mapped ${old.n}` }), result: (old: number) => old } },
		});
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const seen: unknown[] = [];
		let job: JobHandle<{ n: number }, number, undefined> | undefined;
		await host.load(
			[
				{
					name: "@app/reserve",
					facet: defineFacet((h) =>
						h.serve(Owner, (_, self) => {
							job = self.job(V1, {
								run: async (args) => {
									seen.push(args.n);
									return 42;
								},
							});
							return {};
						}),
					),
				},
			],
			context,
		);
		// The run's reservation (the second commit) waits on `gate` until the swap to V2 happened.
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const commit = store.commit.bind(store);
		let writes = 0;
		store.commit = (staged, fence, ctx) => {
			if (++writes !== 2) return commit(staged, fence, ctx);
			const held: StagedWrite = {
				order: "write",
				apply: async () => {
					entered.resolve();
					await gate.promise;
					return [];
				},
			};
			return commit([...staged, held], fence, ctx);
		};
		const starting = job!.start({ n: 1 }, context);
		await entered.promise;
		const run = await starting;
		const v2 = defineFacet((h) =>
			h.serve(Owner, (_, self) => {
				self.job(V2, { run: async () => 43 });
				return {};
			}),
		);
		const reloading = host.reload([{ name: "@app/reserve", facet: v2 }], context);
		await delivered();
		gate.resolve();
		await reloading;
		await run.outcome(context);
		// V1's handler got V1's args.
		expect(seen).toEqual([1]);
		store.commit = commit;
		await host.close(context);
		await store.close(context);
	});
});
