// Tests of jobs in memory (§15): starts (args, dedupe, concurrency, `tx.start`, `outcome`, when `run` starts), runs
// (the ctx, the state document and its fence, throws and aborts), finishes (cleanup, retries, blocked, dropped),
// `running`, keep-alive, the object's end, cost guards and GC.

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	type Context,
	BACKGROUND_CONTEXT as context,
	withAbortSignal,
	withCancel,
} from "../../../src/context/index.ts";
import type { Op } from "../../../src/delta/index.ts";
import { arr, int, local, obj, remote, str, unknown } from "../../../src/next/contracts/index.ts";
import { ChordError, PluginError, type Principal } from "../../../src/next/data/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type HostError, type Self, untilAborted } from "../../../src/next/host/index.ts";
import {
	defineJob,
	type JobCtx,
	type JobDefinition,
	type JobHandle,
	type JobImplementation,
	type Outcome,
	type Run,
} from "../../../src/next/jobs/index.ts";
import { type Link, memoryLinkPair } from "../../../src/next/link/index.ts";
import { Batch } from "../../../src/next/state/internal.ts";
import {
	delivered,
	expectCollected,
	fakeTimers,
	flushed,
	framesOf,
	loaded,
	metered,
	rejection,
	type TestPrincipal,
	transported,
} from "../support.ts";

const Log = defineState("app.log", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

const Progress = defineState("app.progress", {
	schema: obj({ output: str() }),
	version: 1,
	initial: () => ({ output: "" }),
});

/** A job without a state document. */
const Echo = defineJob("app.echo", { version: 1, args: obj({ text: str() }), result: str() });

/** A job with a state document and one run at a time. */
const Shell = defineJob("app.shell", {
	version: 1,
	args: obj({ command: str() }),
	result: obj({ exit: int() }),
	state: Progress,
	concurrency: 1,
});

/** The host-lifetime object of most tests: its log document, and the jobs the test declares. */
const Store = local("app.store", { version: 1, params: {}, members: { log: obj({ list: arr(str()) }) } });

/** The same with params: it lives while referenced or running jobs. */
const Item = local("app.item", { version: 1, params: { id: int() }, members: { log: obj({ list: arr(str()) }) } });

type Declared<A, R, S> = {
	readonly self: Self;
	readonly log: SingletonHandle<{ list: string[] }>;
	readonly job: JobHandle<A, R, S>;
	readonly errors: HostError[];
};

/** Loads a host serving `Store` with the job `definition`; `implement` gets the object's `self` and log. */
async function declared<A, R, S>(
	definition: JobDefinition<A, R, S>,
	implement: (self: Self, log: SingletonHandle<{ list: string[] }>) => JobImplementation<A, R, S>,
	options: Parameters<typeof loaded>[1] = {},
): Promise<Declared<A, R, S> & { readonly host: Awaited<ReturnType<typeof loaded>>["host"] }> {
	let found: Omit<Declared<A, R, S>, "errors"> | undefined;
	const { host, errors } = await loaded(
		(h) =>
			h.serve(Store, (_, self) => {
				const log = self.state(Log);
				found = { self, log, job: self.job(definition, implement(self, log)) };
				return { log };
			}),
		options,
	);
	return { ...found!, errors, host };
}

/** Appends `entry` to the log in `tx`. */
async function append(
	tx: Parameters<Parameters<Self["tx"]>[0]>[0],
	log: SingletonHandle<{ list: string[] }>,
	entry: string,
) {
	(await tx.draft(log)).list.push(entry);
}

/** A `run` that waits for `gate`, then returns `text`. */
function gated(gate: Promise<void>) {
	return async ({ text }: { text: string }) => {
		await gate;
		return text;
	};
}

/** The reported job errors, as `kind id: message`. */
function jobReports(errors: readonly HostError[]): string[] {
	return errors.flatMap((error) => {
		if (error.kind === "job_failed" || error.kind === "job_finish_failed") {
			return [`${error.kind}: ${(error.error as Error).message}`];
		}
		return error.kind === "job_dropped" ? [`${error.kind} ${error.job}`] : [];
	});
}

describe("start", () => {
	it("checks the args against the definition (invalid/args) before anything is recorded", async () => {
		const { job } = await declared(Echo, () => ({ run: async ({ text }) => text }));
		// Plugin code passing wrong args (not type-checked).
		const wrong = { text: 1 } as unknown as { text: string };
		expect(await rejection(job.start(wrong, context))).toMatchObject({ code: "invalid", reason: "args" });
		const extra = { text: "a", more: true } as unknown as { text: string };
		expect(await rejection(job.start(extra, context))).toMatchObject({ code: "invalid", reason: "args" });
		expect(job.running.value).toEqual([]);
	});

	it("compiles the args check once per definition (cost guard)", async () => {
		const { telemetry, context: counting, counts } = await metered();
		const { job } = await declared(Echo, () => ({ run: async ({ text }) => text }), { telemetry });
		const before = counts()["chord.data.compilations"] ?? 0;
		for (const text of ["a", "b", "c"]) await (await job.start({ text }, counting)).outcome(context);
		expect((counts()["chord.data.compilations"] ?? 0) - before).toBeLessThanOrEqual(1);
		expect(counts()["chord.data.validations"]).toBeGreaterThanOrEqual(3);
	});

	it("returns the unsettled run with the same key, across transactions, whatever its args", async () => {
		const gate = Promise.withResolvers<void>();
		const { job } = await declared(Echo, () => ({ run: gated(gate.promise) }));
		// Two starts in one turn: the line serializes them, the second sees the first's record.
		const [first, again] = await Promise.all([
			job.start({ text: "a" }, context, { key: "k" }),
			job.start({ text: "other" }, context, { key: "k" }),
		]);
		expect(again).toBe(first);
		expect(await job.start({ text: "third" }, context, { key: "k" })).toBe(first);
		expect(job.running.value).toHaveLength(1);
		gate.resolve();
		expect(await first.outcome(context)).toMatchObject({ kind: "done", result: "a" });
		// Settled: the key names nothing any more (Q9).
		const next = await job.start({ text: "b" }, context, { key: "k" });
		expect(next.id).not.toBe(first.id);
	});

	it("commits nothing for a start that only dedupes", async () => {
		const gate = Promise.withResolvers<void>();
		const { job } = await declared(Echo, () => ({ run: gated(gate.promise) }));
		const run = await job.start({ text: "a" }, context, { key: "k" });
		const commits = vi.spyOn(Batch.prototype, "commit");
		try {
			expect(await job.start({ text: "a" }, context, { key: "k" })).toBe(run);
			expect(commits).not.toHaveBeenCalled();
		} finally {
			commits.mockRestore();
			gate.resolve();
		}
	});

	it("returns the same run for a key started twice in one transaction", async () => {
		const { job, self } = await declared(Echo, () => ({ run: async ({ text }) => text }));
		const [one, two] = await self.tx(async (tx) => {
			return [tx.start(job, { text: "a" }, { key: "k" }), tx.start(job, { text: "b" }, { key: "k" })];
		}, context);
		expect(two).toBe(one);
		expect((await one!.outcome(context)).args).toEqual({ text: "a" });
	});

	describe("at the concurrency limit", () => {
		fakeTimers();

		it("rejects unavailable/busy: running and finishing runs count", async () => {
			const runGate = Promise.withResolvers<void>();
			let finishes = 0;
			const { job } = await declared(Shell, () => ({
				run: async () => {
					await runGate.promise;
					return { exit: 0 };
				},
				finish: async () => {
					// The first finish throws: the run stays finishing during the backoff, the line free.
					if (finishes++ === 0) throw new Error("once");
				},
			}));
			const run = await job.start({ command: "a" }, context);
			const busy = { code: "unavailable", reason: "busy" };
			expect(await rejection(job.start({ command: "b" }, context))).toMatchObject(busy);
			runGate.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(job.running.value.map((entry) => entry.phase)).toEqual(["finishing"]);
			expect(await rejection(job.start({ command: "b" }, context))).toMatchObject(busy);
			await vi.advanceTimersByTimeAsync(1_000);
			await run.outcome(context);
			await (await job.start({ command: "c" }, context)).outcome(context);
		});
	});

	it("counts runs started earlier in the same transaction", async () => {
		const { job, self } = await declared(Shell, () => ({ run: async () => ({ exit: 0 }) }));
		const error = await rejection(
			self.tx(async (tx) => {
				tx.start(job, { command: "a" });
				tx.start(job, { command: "b" });
			}, context),
		);
		expect(error).toMatchObject({ code: "unavailable", reason: "busy" });
		expect(job.running.value).toEqual([]);
	});

	it("lets finish chain the same job at concurrency 1: its own run is not counted", async () => {
		const done: string[] = [];
		const { job } = await declared(Shell, (_, log) => ({
			run: async ({ command }) => ({ exit: command.length }),
			finish: async (outcome, tx) => {
				done.push(outcome.args.command);
				await append(tx, log, outcome.args.command);
				if (outcome.args.command.length < 3) tx.start(job, { command: `${outcome.args.command}x` });
			},
		}));
		await (await job.start({ command: "a" }, context)).outcome(context);
		await flushed();
		await flushed();
		expect(done).toEqual(["a", "ax", "axx"]);
	});

	it("lets finish start the same job again with the same key: a new run, not the finishing one", async () => {
		const gate = Promise.withResolvers<void>();
		let successor: Run<unknown> | undefined;
		const { job } = await declared(Echo, () => ({
			run: async ({ text }) => {
				if (text === "again") await gate.promise;
				return text;
			},
			finish: async (outcome, tx) => {
				if (outcome.args.text === "first") successor = tx.start(job, { text: "again" }, { key: "k" });
			},
		}));
		const first = await job.start({ text: "first" }, context, { key: "k" });
		expect(await first.outcome(context)).toMatchObject({ kind: "done", result: "first" });
		expect(successor!.id).not.toBe(first.id);
		expect(job.running.value).toMatchObject([{ id: successor!.id, key: "k", phase: "running" }]);
		// The key names the successor now.
		expect(await job.start({ text: "other" }, context, { key: "k" })).toBe(successor);
		gate.resolve();
		expect(await successor!.outcome(context)).toMatchObject({ kind: "done", result: "again" });
	});

	it("tx.start commits with the transaction's other writes, both or neither", async () => {
		const { job, self, log } = await declared(Echo, () => ({ run: async ({ text }) => text }));
		const run = await self.tx(async (tx) => {
			await append(tx, log, "requested");
			return tx.start(job, { text: "a" });
		}, context);
		expect(log.value.list).toEqual(["requested"]);
		expect((await run.outcome(context)).kind).toBe("done");
		let discarded: Run<unknown> | undefined;
		const error = await rejection(
			self.tx(async (tx) => {
				await append(tx, log, "lost");
				discarded = tx.start(job, { text: "b" });
				throw new Error("changed my mind");
			}, context),
		);
		expect(error).toMatchObject({ message: "changed my mind" });
		expect(log.value.list).toEqual(["requested"]);
		expect(job.running.value).toEqual([]);
		expect(await rejection(discarded!.outcome(context))).toMatchObject({ code: "released" });
		expect(await rejection(job.outcome(discarded!.id, context))).toMatchObject({ code: "gone" });
	});

	it("gives a short run's handle its outcome however late the caller waits", async () => {
		const { job } = await declared(Echo, () => ({ run: async ({ text }) => text }));
		const run = await job.start({ text: "quick" }, context);
		await flushed();
		expect(job.running.value).toEqual([]);
		expect(await run.outcome(context)).toEqual({
			id: run.id,
			args: { text: "quick" },
			kind: "done",
			result: "quick",
		});
	});

	it("waits by id for unsettled runs only: settled and unknown ids reject gone", async () => {
		const gate = Promise.withResolvers<void>();
		const { job } = await declared(Echo, () => ({ run: gated(gate.promise) }));
		const run = await job.start({ text: "a" }, context);
		const waiting = job.outcome(run.id, context);
		gate.resolve();
		expect((await waiting).kind).toBe("done");
		expect(await rejection(job.outcome(run.id, context))).toMatchObject({ code: "gone" });
		expect(await rejection(job.outcome("nope", context))).toMatchObject({ code: "gone" });
	});

	it("starts run after the commit, outside the batch, once the transaction settled", async () => {
		const seen: string[] = [];
		const { job, self, log } = await declared(Echo, (s, l) => ({
			run: async ({ text }) => {
				seen.push(`run sees ${l.value.list.join(",")}`);
				// Outside the batch and the line: a transaction of its own works.
				await s.tx(async (tx) => append(tx, l, `from run ${text}`), context);
				return text;
			},
		}));
		const run = await self.tx(async (tx) => {
			const started = tx.start(job, { text: "a" });
			await append(tx, log, "written with the start");
			seen.push("transaction done");
			return started;
		}, context);
		await run.outcome(context);
		expect(seen).toEqual(["transaction done", "run sees written with the start"]);
		expect(log.value.list).toEqual(["written with the start", "from run a"]);
	});

	it("an abort between the commit and the start is marked, then the signal fires; the abort joins run (D7)", async () => {
		let signalled: boolean | undefined;
		const { job } = await declared(Echo, () => ({
			run: async ({ text }, ctx) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				signalled = ctx.abortSignal?.aborted;
				return text;
			},
		}));
		const watch = await job.running.watch(context);
		const aborts: Promise<string>[] = [];
		// The watch's frame of the start's commit arrives before `run` starts.
		watch.start(async (call) => {
			if (call.kind !== "value" || aborts.length > 0) return;
			for (const entry of call.value) aborts.push(job.abort(entry.id, context));
		});
		const run = await job.start({ text: "a" }, context);
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: "a" });
		expect(signalled).toBe(true);
		expect(await Promise.all(aborts)).toEqual(["marked"]);
		expect(await job.abort(run.id, context)).toBe("terminal");
		await watch.stop();
	});

	it("creates nothing for an aborted caller; a caller aborted after the commit does not cancel the run", async () => {
		const gate = Promise.withResolvers<void>();
		let signalled: boolean | undefined;
		const { job } = await declared(Echo, () => ({
			run: async ({ text }, ctx) => {
				await gate.promise;
				signalled = ctx.abortSignal?.aborted;
				return text;
			},
		}));
		const early = withCancel(context);
		early.cancel(new Error("gone already"));
		expect(await rejection(job.start({ text: "a" }, early.context))).toMatchObject({ message: "gone already" });
		expect(job.running.value).toEqual([]);
		const caller = withCancel(context);
		const run = await job.start({ text: "b" }, caller.context);
		caller.cancel(new Error("caller left"));
		gate.resolve();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: "b" });
		expect(signalled).toBe(false);
	});

	it("rolls back the transaction's other writes when the state's initial() fails, naming the definition", async () => {
		const Bad = defineState("app.bad-state", {
			schema: obj({ output: str() }),
			version: 1,
			// Plugin code: a wrong initial value.
			initial: () => ({ output: 1 }) as unknown as { output: string },
		});
		const BadJob = defineJob("app.bad", { version: 1, args: obj({ text: str() }), result: str(), state: Bad });
		const { job, self, log } = await declared(BadJob, () => ({ run: async ({ text }) => text }));
		const error = await rejection(
			self.tx(async (tx) => {
				await append(tx, log, "lost");
				tx.start(job, { text: "a" });
			}, context),
		);
		expect(error).toMatchObject({ message: "app.bad-state: initial() does not match the schema" });
		expect({ log: log.value.list, running: job.running.value }).toEqual({ log: [], running: [] });
	});

	it("is refused before its object is live and once it ended", async () => {
		let early: Promise<unknown> | undefined;
		const { host } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const log = self.state(Log);
				const job = self.job(Echo, { run: async ({ text }) => text });
				self.open(
					async () => {
						early = job.start({ text: "a" }, context);
						return null;
					},
					() => {},
				);
				return { log };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		expect(await rejection(early!)).toMatchObject({ code: "not_ready" });
		item.release();
	});
});

describe("self.job", () => {
	it("is declared once per job name, only while the factory runs", async () => {
		let later: Self | undefined;
		const { host, errors } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				later = self;
				self.job(Echo, { run: async ({ text }) => text });
				self.job(Echo, { run: async ({ text }) => text });
				return { log: self.state(Log) };
			}),
		);
		expect(await rejection(host.get(Item, { id: 1 }, context))).toMatchObject({
			message: expect.stringContaining('job "app.echo" is declared twice'),
		});
		expect(errors.map((error) => error.kind)).toEqual(["activation_failed"]);
		expect(() => later!.job(Shell, { run: async () => ({ exit: 0 }) })).toThrow(
			"app.item(1): self.job is valid only in the factory",
		);
	});
});

describe("run", () => {
	it("gets a ctx with the run's id, the host's principal for a local object, and no state without one", async () => {
		let seen: Record<string, unknown> | undefined;
		const host = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		let job: JobHandle<{ text: string }, string, undefined> | undefined;
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(Store, (_, self) => {
				job = self.job(Echo, {
					run: async ({ text }, ctx) => {
						seen = { jobId: ctx.jobId, principal: ctx.principal, hasState: "state" in ctx };
						expectTypeOf(ctx).toEqualTypeOf<JobCtx<TestPrincipal, undefined>>();
						return text;
					},
				});
				return { log: self.state(Log) };
			}),
		);
		await host.load([{ name: "@test/app", facet }], context);
		const run = await job!.start({ text: "a" }, context);
		await run.outcome(context);
		expect(seen).toEqual({ jobId: run.id, principal: { kind: "server" }, hasState: false });
		await host.close(context);
	});

	it("reads and changes its state document; `running` carries it", async () => {
		const gate = Promise.withResolvers<void>();
		const values: string[] = [];
		const { job } = await declared(Shell, () => ({
			run: async (_, ctx) => {
				values.push(ctx.state.value.output);
				await ctx.state.change((d) => {
					d.output = "half";
				}, ctx);
				values.push(ctx.state.value.output);
				await gate.promise;
				return { exit: 0 };
			},
		}));
		const run = await job.start({ command: "a" }, context);
		await flushed();
		expect(job.running.value).toEqual([
			{ id: run.id, version: 1, args: { command: "a" }, state: { output: "half" }, phase: "running" },
		]);
		gate.resolve();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", state: { output: "half" } });
		expect(values).toEqual(["", "half"]);
	});

	it("keeps its state documents apart from the object's own documents of the same definition", async () => {
		const gate = Promise.withResolvers<void>();
		const Many = defineJob("app.many", { version: 1, args: obj({ n: int() }), result: int(), state: Progress });
		let mine: SingletonHandle<{ output: string }> | undefined;
		let job: JobHandle<{ n: number }, number, { output: string }> | undefined;
		await loaded((h) =>
			h.serve(Store, (_, self) => {
				mine = self.state(Progress);
				job = self.job(Many, {
					run: async ({ n }, ctx) => {
						await ctx.state.change((d) => {
							d.output = `run ${n}`;
						}, ctx);
						await gate.promise;
						return n;
					},
				});
				return { log: self.state(Log) };
			}),
		);
		const runs = await Promise.all([job!.start({ n: 1 }, context), job!.start({ n: 2 }, context)]);
		await flushed();
		expect(job!.running.value.map((entry) => entry.phase !== "blocked" && entry.state.output)).toEqual([
			"run 1",
			"run 2",
		]);
		expect(mine!.value).toEqual({ output: "" });
		gate.resolve();
		expect((await Promise.all(runs.map((run) => run.outcome(context)))).map((o) => o.state.output)).toEqual([
			"run 1",
			"run 2",
		]);
	});

	it("refuses state changes once run settled (released), and never recreates the retired document", async () => {
		let captured: JobCtx<Principal, { output: string }> | undefined;
		let inFinish: unknown;
		const { job } = await declared(Shell, () => ({
			run: async (_, ctx) => {
				captured = ctx;
				return { exit: 0 };
			},
			// After run returned, before finish committed: refused; the outcome's state is the state at run's settle.
			finish: async (outcome) => {
				inFinish = [outcome.state, await rejection(captured!.state.change(() => {}, context))];
			},
		}));
		await (await job.start({ command: "a" }, context)).outcome(context);
		expect(inFinish).toEqual([{ output: "" }, expect.objectContaining({ code: "released" })]);
		const late = captured!.state.change((d) => {
			d.output = "late";
		}, context);
		expect(await rejection(late)).toMatchObject({ code: "released" });
		expect(() => captured!.state.value).toThrow(ChordError);
		expect(job.running.value).toEqual([]);
	});

	it("commits a change still waiting for the line when run settles, before the outcome is recorded", async () => {
		const go = Promise.withResolvers<void>();
		const line = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let returned = false;
		const { job, self } = await declared(Shell, () => ({
			run: async (_, ctx) => {
				await go.promise;
				// Admitted while run runs; it waits behind the transaction holding the line.
				void ctx.state.change((d) => {
					d.output = "last words";
				}, ctx);
				returned = true;
				return { exit: 0 };
			},
		}));
		const run = await job.start({ command: "a" }, context);
		const holding = self.tx(async () => {
			entered.resolve();
			await line.promise;
		}, context);
		await entered.promise;
		go.resolve();
		await flushed();
		// run settled with its change still waiting: nothing committed, the outcome not recorded yet.
		expect(returned).toBe(true);
		expect(job.running.value).toMatchObject([{ phase: "running", state: { output: "" } }]);
		line.resolve();
		await holding;
		expect(await run.outcome(context)).toMatchObject({ kind: "done", state: { output: "last words" } });
	});

	it("commits changes made after an abort while run stops; a throw then ends aborted, not threw", async () => {
		const { job, errors } = await declared(Shell, () => ({
			run: async (_, ctx) => {
				await untilAborted(ctx);
				await ctx.state.change((d) => {
					d.output = "stopped cleanly";
				}, ctx);
				throw new Error("interrupted");
			},
		}));
		const run = await job.start({ command: "a" }, context);
		await flushed();
		void job.abort(run.id, context);
		expect(await run.outcome(context)).toEqual({
			id: run.id,
			args: { command: "a" },
			state: { output: "stopped cleanly" },
			kind: "failed",
			error: { kind: "aborted", reason: "abort" },
		});
		expect(jobReports(errors)).toEqual([]);
	});

	it("keeps a result returned after an abort", async () => {
		const { job } = await declared(Echo, () => ({
			run: async ({ text }, ctx) => {
				await untilAborted(ctx);
				return text;
			},
		}));
		const run = await job.start({ text: "kept" }, context);
		await flushed();
		void job.abort(run.id, context);
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: "kept" });
	});

	it("ends threw when run throws, reported as job_failed; a plain error becomes PluginError internal", async () => {
		const plugin = new PluginError("quota", "too many");
		const { job, errors } = await declared(Echo, () => ({
			run: async ({ text }) => {
				if (text === "plugin") throw plugin;
				throw new Error("plain");
			},
		}));
		const first = await (await job.start({ text: "plugin" }, context)).outcome(context);
		expect(first).toMatchObject({ kind: "failed", error: { kind: "threw", error: plugin } });
		const second = await (await job.start({ text: "plain" }, context)).outcome(context);
		expect(second.kind === "failed" && second.error).toMatchObject({ kind: "threw" });
		const thrown = second.kind === "failed" && second.error.kind === "threw" ? second.error.error : undefined;
		expect(thrown).toBeInstanceOf(PluginError);
		expect(thrown).toMatchObject({ code: "internal", message: "plain" });
		expect(jobReports(errors)).toEqual(["job_failed: too many", "job_failed: plain"]);
		expect(errors[0]).toMatchObject({ kind: "job_failed", object: "app.store", job: "app.echo", id: first.id });
	});

	it("releases its ctx.get references when it settles", async () => {
		const Other = local("app.other", {
			version: 1,
			params: { id: int() },
			members: { log: obj({ list: arr(str()) }) },
		});
		let job: JobHandle<{ text: string }, string, undefined> | undefined;
		const { host } = await loaded((h) => {
			h.serve(Other, (_, self) => ({ log: self.state(Log) }));
			h.serve(Store, (_, self) => {
				job = self.job(Echo, {
					run: async ({ text }, ctx) => {
						await ctx.get(Other, { id: 1 });
						expect(host.references(Other).value).toHaveLength(1);
						return text;
					},
				});
				return { log: self.state(Log) };
			});
		});
		await (await job!.start({ text: "a" }, context)).outcome(context);
		expect(host.references(Other).value).toHaveLength(0);
	});

	it("that ignores its signal at the object's end is drained up to closeTimeout; its later changes are refused", async () => {
		const gate = Promise.withResolvers<void>();
		const late = Promise.withResolvers<unknown>();
		const { job, host, errors } = await declared(
			Shell,
			() => ({
				run: async (_, ctx) => {
					await gate.promise;
					late.resolve(
						await rejection(
							ctx.state.change((d) => {
								d.output = "too late";
							}, ctx),
						),
					);
					return { exit: 0 };
				},
			}),
			{ closeTimeout: 20 },
		);
		await job.start({ command: "a" }, context);
		await flushed();
		await host.close(context);
		expect(errors).toEqual([{ kind: "drain_timeout", object: "app.store" }]);
		gate.resolve();
		expect(await late.promise).toMatchObject({ code: "released" });
	});

	it("may start the same job again from run (recursion): a new run", async () => {
		const ids: string[] = [];
		const { job } = await declared(Echo, () => ({
			run: async ({ text }, ctx) => {
				ids.push(ctx.jobId);
				if (text.length < 3) await job.start({ text: `${text}+` }, ctx);
				return text;
			},
		}));
		await (await job.start({ text: "a" }, context)).outcome(context);
		await flushed();
		await flushed();
		expect(new Set(ids).size).toBe(3);
	});
});

describe("finish", () => {
	it("gets each outcome kind; the record, key and state document go in its commit, atomically with its writes", async () => {
		const outcomes: string[] = [];
		const { job, log, self } = await declared(Shell, (_, l) => ({
			run: async ({ command }, ctx) => {
				await ctx.state.change((d) => {
					d.output = `out ${command}`;
				}, ctx);
				if (command === "fail") throw new Error("no");
				return { exit: 0 };
			},
			finish: async (outcome, tx) => {
				outcomes.push(`${outcome.kind} ${outcome.state.output}`);
				await append(tx, l, outcome.args.command);
			},
		}));
		// The log entry and the removed entry arrive in one commit: whenever the log's watch sees an entry, the run is gone.
		const seen: [number, number][] = [];
		(await log.watch(context)).start(async (call) => {
			if (call.kind === "value") seen.push([call.value.list.length, job.running.value.length]);
		});
		void self;
		await (await job.start({ command: "ok" }, context, { key: "k" })).outcome(context);
		await (await job.start({ command: "fail" }, context, { key: "k" })).outcome(context);
		await delivered();
		expect(outcomes).toEqual(["done out ok", "failed out fail"]);
		expect(seen).toEqual([
			[1, 0],
			[2, 0],
		]);
		expect(job.running.value).toEqual([]);
	});

	it("only cleans up without a finish", async () => {
		const { job } = await declared(Shell, () => ({ run: async () => ({ exit: 3 }) }));
		const run = await job.start({ command: "a" }, context, { key: "k" });
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { exit: 3 } });
		expect(job.running.value).toEqual([]);
	});

	describe("throwing", () => {
		fakeTimers();

		it("is retried after 1 s doubling, each failure reported; a later success finishes the run", async () => {
			const at: number[] = [];
			const { job, errors } = await declared(Echo, () => ({
				run: async ({ text }) => text,
				finish: async () => {
					at.push(Date.now());
					if (at.length < 4) throw new Error(`finish ${at.length}`);
				},
			}));
			const run = await job.start({ text: "a" }, context);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(at).toEqual([0, 1_000, 3_000, 7_000]);
			expect(jobReports(errors)).toEqual([
				"job_finish_failed: finish 1",
				"job_finish_failed: finish 2",
				"job_finish_failed: finish 3",
			]);
			expect((await run.outcome(context)).kind).toBe("done");
		});

		it("blocks the run after five failures in a row: outcome, state and key kept, not counted; abort drops it", async () => {
			const { job, errors } = await declared(Shell, () => ({
				run: async (_, ctx) => {
					await ctx.state.change((d) => {
						d.output = "kept";
					}, ctx);
					return { exit: 0 };
				},
				finish: async () => {
					throw new Error("always");
				},
			}));
			const run = await job.start({ command: "a" }, context, { key: "k" });
			const { context: waiting, cancel } = withCancel(context);
			const waiter = rejection(run.outcome(waiting));
			const dropped = rejection(run.outcome(context));
			await vi.advanceTimersByTimeAsync(60_000);
			expect(jobReports(errors)).toHaveLength(5);
			expect(job.running.value).toEqual([{ id: run.id, version: 1, phase: "blocked", reason: "finish_failed" }]);
			// Its waiters keep waiting; their own context ends a wait.
			cancel(new Error("gave up"));
			expect(await waiter).toMatchObject({ message: "gave up" });
			// Dedupe returns it; a different key starts a new run (blocked runs do not count for concurrency).
			expect(await job.start({ command: "b" }, context, { key: "k" })).toBe(run);
			const other = await job.start({ command: "c" }, context, { key: "other" });
			await vi.advanceTimersByTimeAsync(0);
			expect(job.running.value.map((entry) => entry.phase)).toEqual(["blocked", "finishing"]);
			void job.abort(run.id, context);
			await vi.advanceTimersByTimeAsync(0);
			expect(await dropped).toMatchObject({ code: "aborted" });
			expect(job.running.value.map((entry) => entry.id)).toEqual([other.id]);
			expect(errors.filter((error) => error.kind === "job_dropped")).toEqual([
				{ kind: "job_dropped", object: "app.store", job: "app.shell", id: run.id },
			]);
		});
	});

	describe("backing off", () => {
		fakeTimers();

		it("leaves no timer behind when its object ends during the backoff", async () => {
			const { job, host, errors } = await declared(Echo, () => ({
				run: async ({ text }) => text,
				finish: async () => {
					throw new Error("stuck");
				},
			}));
			const run = rejection((await job.start({ text: "a" }, context)).outcome(context));
			await vi.advanceTimersByTimeAsync(0);
			expect(errors).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(1);
			await host.close(context);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(errors).toHaveLength(1);
			expect(await run).toMatchObject({ code: "released" });
		});
	});

	it("ignores an abort while it runs", async () => {
		const gate = Promise.withResolvers<void>();
		const { job } = await declared(Echo, () => ({
			run: async ({ text }) => text,
			finish: async () => gate.promise,
		}));
		const run = await job.start({ text: "a" }, context);
		await flushed();
		void job.abort(run.id, context);
		gate.resolve();
		expect((await run.outcome(context)).kind).toBe("done");
	});

	it("does not run when its object ends while the outcome and finish wait for the line: no call, no report", async () => {
		const go = Promise.withResolvers<void>();
		const line = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const finished: string[] = [];
		const { job, self, host, errors } = await declared(Echo, () => ({
			run: async ({ text }) => {
				await go.promise;
				return text;
			},
			finish: async ({ args }) => void finished.push(args.text),
		}));
		const run = await job.start({ text: "a" }, context);
		const waiting = rejection(run.outcome(context));
		const holding = self.tx(async () => {
			entered.resolve();
			await line.promise;
		}, context);
		await entered.promise;
		// run settles while the line is held: its outcome and finish queue behind it.
		go.resolve();
		await flushed();
		const closing = host.close(context);
		line.resolve();
		await holding.catch(() => {});
		await closing;
		expect({ finished, errors }).toEqual({ finished: [], errors: [] });
		expect(await waiting).toMatchObject({ code: "released" });
	});

	it("is drained at the object's end when it runs: its commit is refused, nothing is reported", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const events: string[] = [];
		const { job, host, errors } = await declared(Echo, () => ({
			run: async ({ text }) => text,
			finish: async () => {
				entered.resolve();
				await gate.promise;
				events.push("finish returned");
			},
		}));
		await job.start({ text: "a" }, context);
		await entered.promise;
		const closing = host.close(context).then(() => void events.push("closed"));
		await flushed();
		expect(events).toEqual([]);
		gate.resolve();
		await closing;
		expect(events).toEqual(["finish returned", "closed"]);
		expect(errors).toEqual([]);
	});
});

describe("running", () => {
	it("has one entry per unsettled run, in start order, tagged by phase; a key when given", async () => {
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const finishing = Promise.withResolvers<void>();
		const { job } = await declared(Echo, () => ({
			run: async ({ text }) => {
				await gates[Number(text)]!.promise;
				return text;
			},
			finish: async () => finishing.promise,
		}));
		const zero = await job.start({ text: "0" }, context, { key: "z" });
		const one = await job.start({ text: "1" }, context);
		gates[0]!.resolve();
		await flushed();
		expect(job.running.value).toEqual([
			{ id: zero.id, version: 1, key: "z", args: { text: "0" }, phase: "finishing" },
			{ id: one.id, version: 1, args: { text: "1" }, phase: "running" },
		]);
		finishing.resolve();
		gates[1]!.resolve();
		await one.outcome(context);
		expect(job.running.value).toEqual([]);
	});

	it("replaces only the entry whose state changed, with ops under its entry (cost guard: no walk of other runs)", async () => {
		const gate = Promise.withResolvers<void>();
		const contexts = new Map<string, JobCtx<Principal, { output: string }>>();
		const Many = defineJob("app.many", { version: 1, args: obj({ n: int() }), result: int(), state: Progress });
		const { job } = await declared(Many, () => ({
			run: async ({ n }, ctx) => {
				contexts.set(String(n), ctx);
				await gate.promise;
				return n;
			},
		}));
		for (let n = 0; n < 100; n++) await job.start({ n }, context);
		await flushed();
		const before = job.running.value;
		const frames = framesOf(await job.running.watch(context));
		await contexts.get("42")!.state.change((d) => {
			d.output = "x";
		}, context);
		await delivered();
		const after = job.running.value;
		expect(after).not.toBe(before);
		expect(after.filter((entry, index) => entry !== before[index])).toHaveLength(1);
		expect(after[42]).toMatchObject({ state: { output: "x" } });
		expect(frames.map(([, ops]) => ops)).toEqual([[["a", [42, "state", "output"], "x"]] satisfies Op[]]);
		gate.resolve();
	});

	it("does no validation, walk or compilation for a state change (cost guard)", async () => {
		const { telemetry, context: counting, counts } = await metered();
		const gate = Promise.withResolvers<void>();
		const contexts: JobCtx<Principal, { output: string }>[] = [];
		const { job } = await declared(
			Shell,
			() => ({
				run: async (_, ctx) => {
					contexts.push(ctx);
					await gate.promise;
					return { exit: 0 };
				},
			}),
			{ telemetry, context: counting },
		);
		await job.start({ command: "a" }, counting);
		await flushed();
		const frames = framesOf(await job.running.watch(context));
		const data = () => Object.entries(counts()).filter(([name]) => name.startsWith("chord.data."));
		const before = data();
		await contexts[0]!.state.change((d) => {
			d.output = "x".repeat(10_000);
		}, context);
		await delivered();
		expect(data()).toEqual(before);
		expect(frames).toHaveLength(1);
		gate.resolve();
	});

	it("frames record changes as splices and sets of the list", async () => {
		const gate = Promise.withResolvers<void>();
		const { job } = await declared(Echo, () => ({ run: gated(gate.promise) }));
		const frames = framesOf(await job.running.watch(context));
		const run = await job.start({ text: "a" }, context);
		await delivered();
		gate.resolve();
		await run.outcome(context);
		await delivered();
		const entry = { id: run.id, version: 1, args: { text: "a" }, phase: "running" };
		expect(frames.map(([, ops]) => ops)).toEqual([
			[["p", [], 0, 0, [entry]]],
			[["s", [0], { ...entry, phase: "finishing" }]],
			[["p", [], 0, 1, []]],
		]);
	});
});

describe("keep-alive", () => {
	it("keeps an object without holders while runs run, and ends it after the last one and its linger", async () => {
		const gate = Promise.withResolvers<void>();
		let job: JobHandle<{ text: string }, string, undefined> | undefined;
		let ended = false;
		const { host } = await loaded((h) =>
			h.serve(
				Item,
				(_, self) => {
					job = self.job(Echo, { run: gated(gate.promise) });
					self.onLive(async (ctx) => {
						await untilAborted(ctx);
						ended = true;
					});
					return { log: self.state(Log) };
				},
				{ linger: 20 },
			),
		);
		const item = await host.get(Item, { id: 1 }, context);
		await job!.start({ text: "a" }, context);
		expect(host.activity.value.jobs).toBe(1);
		expect(host.references(Item).value).toHaveLength(1);
		item.release();
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(ended).toBe(false);
		expect(host.references(Item).value).toHaveLength(0);
		expect(host.activity.value).toMatchObject({ jobs: 1, lingering: 0 });
		gate.resolve();
		await flushed();
		expect(host.activity.value).toMatchObject({ jobs: 0, lingering: 1 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(ended).toBe(true);
		expect(host.activity.value).toMatchObject({ jobs: 0, lingering: 0 });
	});

	it("keeps an object whose last run's finish chains another job: the chained run runs, then the object ends", async () => {
		const A = defineJob("app.a", { version: 1, args: obj({ text: str() }), result: str() });
		const events: string[] = [];
		let a: JobHandle<{ text: string }, string, undefined> | undefined;
		let chained: Run<unknown> | undefined;
		const { host } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				self.open(
					async () => null,
					() => void events.push("object ended"),
				);
				const b = self.job(Echo, {
					run: async ({ text }) => {
						await new Promise((resolve) => setTimeout(resolve, 10));
						events.push(`b ran ${text}`);
						return text;
					},
				});
				a = self.job(A, {
					run: async ({ text }) => text,
					finish: async (_outcome, tx) => {
						chained = tx.start(b, { text: "chained" });
					},
				});
				return { log: self.state(Log) };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		await a!.start({ text: "x" }, context);
		item.release();
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(await chained!.outcome(context)).toMatchObject({ kind: "done", result: "chained" });
		expect(events).toEqual(["b ran chained", "object ended"]);
		expect(host.activity.value.jobs).toBe(0);
	});

	it("keeps an object whose last reference goes while its start's commit publishes (a link closing as it sends)", async () => {
		const View = remote("app.view", {
			version: 1,
			params: {},
			variants: { v: { state: { running: arr(unknown()) } } },
		});
		let job: JobHandle<{ text: string }, string, undefined> | undefined;
		let ran = false;
		const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, _principal, self) => {
				job = self.job(Echo, {
					run: async ({ text }) => {
						ran = true;
						return text;
					},
				});
				// The running list as a state member, so the start's commit sends a state message.
				return { variant: "v", members: { running: job.running as never } };
			}),
		);
		await server.load([{ name: "@test/app", facet }], context);
		const client = createHost<TestPrincipal>({ onError: () => {} });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		let closeOnSend = false;
		// The server's end of the link closes while it sends: the client's hold, the last reference, goes at once.
		const failing: Link = {
			send: (message) => {
				if (!closeOnSend) return a.send(message);
				closeOnSend = false;
				a.close();
			},
			onMessage: (listener) => a.onMessage(listener),
			close: () => a.close(),
			onClose: (listener) => a.onClose(listener),
		};
		server.accept(failing, { principal: { kind: "owner" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		await client.get(View, {}, context);
		await transported();
		closeOnSend = true;
		const run = await job!.start({ text: "a" }, context);
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: "a" });
		expect(ran).toBe(true);
		await client.close(context);
		await server.close(context);
	});

	it("drops blocked runs, reported, when the object ends after its last run", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
		try {
			let job: JobHandle<{ text: string }, string, undefined> | undefined;
			const errors: HostError[] = [];
			const host = createHost({ onError: (error) => errors.push(error) });
			const facet = defineFacet((h) =>
				h.serve(Item, (_, self) => {
					job = self.job(Echo, {
						run: async ({ text }) => text,
						finish: async () => {
							throw new Error("stuck");
						},
					});
					return { log: self.state(Log) };
				}),
			);
			await host.load([{ name: "@test/app", facet }], context);
			const item = await host.get(Item, { id: 1 }, context);
			const run = await job!.start({ text: "a" }, context);
			item.release();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(errors.map((error) => error.kind)).toEqual([...Array(5).fill("job_finish_failed"), "job_dropped"]);
			expect(await rejection(run.outcome(context))).toMatchObject({ code: "released" });
			expect(host.activity.value.jobs).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a lingering object when a run starts during its linger", async () => {
		const gate = Promise.withResolvers<void>();
		let job: JobHandle<{ text: string }, string, undefined> | undefined;
		const { host } = await loaded((h) =>
			h.serve(
				Item,
				(_, self) => {
					job = self.job(Echo, { run: gated(gate.promise) });
					return { log: self.state(Log) };
				},
				{ linger: 20 },
			),
		);
		(await host.get(Item, { id: 1 }, context)).release();
		expect(host.activity.value.lingering).toBe(1);
		const run = await job!.start({ text: "a" }, context);
		expect(host.activity.value).toMatchObject({ jobs: 1, lingering: 0 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		gate.resolve();
		expect((await run.outcome(context)).kind).toBe("done");
	});
});

describe("object end", () => {
	type Revocation = { session: string };
	const Jobs = remote("app.jobs", { version: 1, params: {}, variants: { v: { state: {} } } });

	it("revocation (R11): runs' signals fire with the end's error, the drain waits for them, no finish", async () => {
		let job: JobHandle<{ text: string }, string, undefined> | undefined;
		const finished: string[] = [];
		let reason: unknown;
		const server = createHost<TestPrincipal, Revocation>({
			principal: { kind: "server" },
			revokedBy: (p) => (p.kind === "guest" ? [{ session: p.session }] : []),
			onError: () => {},
		});
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(Jobs, (_, _principal, self) => {
				job = self.job(Echo, {
					run: async ({ text }, ctx) => {
						await untilAborted(ctx);
						reason = ctx.abortSignal?.reason;
						await new Promise((resolve) => setTimeout(resolve, 10));
						finished.push("run stopped");
						return text;
					},
					finish: async () => void finished.push("finish"),
				});
				return { variant: "v", members: {} };
			}),
		);
		await server.load([{ name: "@test/app", facet }], context);
		const client = createHost<TestPrincipal>({ onError: () => {} });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "guest", session: "S1" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		await client.get(Jobs, {}, context);
		const run = await job!.start({ text: "a" }, context);
		await flushed();
		server.revoke({ session: "S1" }, context);
		await flushed();
		expect(reason).toMatchObject({ code: "forbidden", reason: "revoked" });
		expect(await rejection(run.outcome(context))).toMatchObject({ code: "forbidden", reason: "revoked" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		await transported();
		expect(finished).toEqual(["run stopped"]);
		expect(server.activity.value.jobs).toBe(0);
		await client.close(context);
		await server.close(context);
	});

	it("drains a run that ends its own object before its first await: its natives stay open until it stops", async () => {
		let job: JobHandle<{ text: string }, string, undefined> | undefined;
		const gate = Promise.withResolvers<void>();
		const events: string[] = [];
		const server = createHost<TestPrincipal, Revocation>({
			principal: { kind: "server" },
			revokedBy: (p) => (p.kind === "guest" ? [{ session: p.session }] : []),
			onError: () => {},
		});
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(Jobs, (_, _principal, self) => {
				self.open(
					async () => null,
					() => void events.push("native closed"),
				);
				job = self.job(Echo, {
					run: async ({ text }) => {
						server.revoke({ session: "S1" }, context);
						await gate.promise;
						events.push("run stopped");
						return text;
					},
				});
				return { variant: "v", members: {} };
			}),
		);
		await server.load([{ name: "@test/app", facet }], context);
		const client = createHost<TestPrincipal>({ onError: () => {} });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "guest", session: "S1" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		await client.get(Jobs, {}, context);
		const run = rejection((await job!.start({ text: "a" }, context)).outcome(context));
		await flushed();
		expect(events).toEqual([]);
		gate.resolve();
		await flushed();
		expect(events).toEqual(["run stopped", "native closed"]);
		expect(await run).toMatchObject({ code: "forbidden", reason: "revoked" });
		await client.close(context);
		await server.close(context);
	});

	it("host.close: signals fire, close waits for the run (drain), no finish, waiters rejected released", async () => {
		const finished: string[] = [];
		const { job, host } = await declared(Echo, () => ({
			run: async ({ text }, ctx) => {
				await untilAborted(ctx);
				await new Promise((resolve) => setTimeout(resolve, 10));
				finished.push("run stopped");
				return text;
			},
			finish: async () => void finished.push("finish"),
		}));
		const run = await job.start({ text: "a" }, context);
		await flushed();
		const waiting = rejection(run.outcome(context));
		await host.close(context);
		expect(finished).toEqual(["run stopped"]);
		expect(await waiting).toMatchObject({ code: "released" });
	});
});

describe("GC", () => {
	it("finished and dropped runs leave nothing on their object", async () => {
		const refs: WeakRef<object>[] = [];
		const { job } = await declared(Echo, () => ({
			run: async (args, ctx) => {
				refs.push(new WeakRef(args), new WeakRef(ctx));
				return args.text;
			},
		}));
		await (await job.start({ text: "a" }, context)).outcome(context);
		await flushed();
		await expectCollected(...refs);
	});

	describe("of dropped runs", () => {
		fakeTimers();

		it("a dropped blocked run leaves nothing on its object", async () => {
			const refs: WeakRef<object>[] = [];
			const { job, errors } = await declared(Echo, () => ({
				run: async (args, ctx) => {
					refs.push(new WeakRef(args), new WeakRef(ctx));
					return args.text;
				},
				finish: async () => {
					throw new Error("stuck");
				},
			}));
			const run = await job.start({ text: "a" }, context);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(job.running.value.map((entry) => entry.phase)).toEqual(["blocked"]);
			const dropped = run.outcome(context).then(
				() => new Error("expected a rejection"),
				(error: Error) => error,
			);
			void job.abort(run.id, context);
			await vi.advanceTimersByTimeAsync(0);
			expect(await dropped).toMatchObject({ code: "aborted" });
			expect(job.running.value).toEqual([]);
			// An error keeps its stack frames' receivers (the dropping transaction) until its stack is read (V8).
			void (await dropped).stack;
			for (const error of errors) if (error.kind === "job_finish_failed") void (error.error as Error).stack;
			await expectCollected(...refs);
		});
	});

	it("keeps nothing of a cancelled wait while its run still runs", async () => {
		const gate = Promise.withResolvers<void>();
		const { job } = await declared(Echo, () => ({ run: gated(gate.promise) }));
		const run = await job.start({ text: "a" }, context);
		/** One wait, cancelled; returns its signal, weakly. */
		const cancelled = async (): Promise<WeakRef<object>> => {
			const controller = new AbortController();
			const waiting = rejection(run.outcome(withAbortSignal(controller.signal, context)));
			controller.abort("gave up");
			expect(await waiting).toBe("gave up");
			return new WeakRef(controller.signal);
		};
		const refs: WeakRef<object>[] = [];
		for (let i = 0; i < 5; i++) refs.push(await cancelled());
		await expectCollected(...refs);
		gate.resolve();
		expect((await run.outcome(context)).kind).toBe("done");
	});

	it("keeps no ended run's args or state in a job handle kept after its object ended", async () => {
		const refs: WeakRef<object>[] = [];
		const { job, host } = await declared(Shell, () => ({
			run: async (args, ctx) => {
				refs.push(new WeakRef(args), new WeakRef(ctx.state.value));
				await untilAborted(ctx);
				return { exit: 1 };
			},
		}));
		await job.start({ command: "a" }, context);
		await flushed();
		await host.close(context);
		await expectCollected(...refs);
		expect(() => job.running.value).toThrow(ChordError);
	});

	it("an ended object releases its runs, their documents and waiters", async () => {
		const refs: WeakRef<object>[] = [];
		let job: JobHandle<{ command: string }, { exit: number }, { output: string }> | undefined;
		const { host } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				job = self.job(Shell, {
					run: async (args, ctx) => {
						refs.push(new WeakRef(args), new WeakRef(ctx), new WeakRef(ctx.state.value));
						await untilAborted(ctx);
						return { exit: 1 };
					},
				});
				return { log: self.state(Log) };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		await job!.start({ command: "a" }, context);
		await flushed();
		refs.push(new WeakRef(job!));
		job = undefined;
		await host.close(context);
		void item;
		await expectCollected(...refs);
	});
});

// The type of `outcome` follows the definition.
expectTypeOf<Outcome<{ command: string }, { exit: number }, { output: string }>["args"]>().toEqualTypeOf<{
	command: string;
}>();
void (null as unknown as Context);
