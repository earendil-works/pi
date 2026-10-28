// Tests of persisted jobs (slice 6b §4, D5-D8, R3): run records and state documents in the object's store, every
// transition of §4.2 across a crash (the store closed under a live host, reopened by a new one), the clean stop and
// the close writer, a seal and its retry, the restart limit and its reset, the finish failure count, a stored abort,
// deferred state.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { MAX_PENDING_OPS } from "../../../src/delta/pending.ts";
import { arr, int, local, num, obj, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { RETENTION_MS, Residency } from "../../../src/next/documents/residency.ts";
import { createHost, defineFacet, type HostError, type StoreSelf } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import {
	defineJob,
	type JobHandle,
	type JobImplementation,
	type Outcome,
	type RunState,
} from "../../../src/next/jobs/index.ts";
import { JobRun } from "../../../src/next/jobs/run.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import { type ChordStore, openStore } from "../../../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { delivered, expectCollected, failLive, instancesOf } from "../support.ts";

const attempted = instancesOf(ChordObject, "attempt");

const Progress = defineState("import.progress", {
	schema: obj({ done: int() }),
	version: 1,
	initial: () => ({ done: 0 }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 8,
});

const Import = defineJob("notes.import", importOptions());

/** `Import`'s declaration, which the other versions below change. */
function importOptions() {
	return {
		version: 1,
		args: obj({ path: str() }),
		result: obj({ count: int() }),
		state: Progress,
		persist: { resume: "rerun" },
	} as const;
}

/** `Import` at the next version, as a deploy changes it. */
const ImportV2 = defineJob("notes.import", { ...importOptions(), version: 2 });

/** `Import` at its version with another result schema (`num` for `int`): another fingerprint. */
const ImportReshaped = defineJob("notes.import", { ...importOptions(), result: obj({ count: num() }) });

const Abandoned = defineJob("notes.abandoned", {
	version: 1,
	args: obj({ path: str() }),
	result: obj({ count: int() }),
	persist: { resume: "abandon" },
});

const Store = local("notes.store", { version: 1, params: {}, members: {} });

type ImportArgs = { readonly path: string };
type ImportResult = { readonly count: number };
type ImportOutcome = Outcome<ImportArgs, ImportResult, { done: number }>;

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

/** A store file opened by `open()` again after each crash or close. */
async function storeFile() {
	directory = await mkdtemp(join(tmpdir(), "chord-jobs-"));
	const path = join(directory, "store.sqlite");
	return async () => (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
}

/** What one host over the store sees of the store object's jobs. */
type Opened = {
	readonly store: ChordStore;
	readonly errors: HostError[];
	readonly imports: JobHandle<ImportArgs, ImportResult, { done: number }>;
	readonly abandoned: JobHandle<ImportArgs, ImportResult, undefined>;
	readonly finished: ImportOutcome[];
	readonly self: StoreSelf;
	/** `ref.retry()` of the store object. */
	retry(): Promise<void>;
	close(): Promise<void>;
	/** A crash: the store's backend closes under the live host, which is left behind. */
	crash(): Promise<void>;
};

/** A host over `store` serving `Store` with both jobs (`Import` or another declaration of it), `run` and `finish` given. */
async function opened(
	store: ChordStore,
	run: JobImplementation<ImportArgs, ImportResult, { done: number }>["run"],
	finish?: (outcome: ImportOutcome) => void,
	declared: typeof Import = Import,
): Promise<Opened> {
	const errors: HostError[] = [];
	const finished: ImportOutcome[] = [];
	const host = createHost({ store, onError: (error) => errors.push(error), closeTimeout: 200 });
	let found: Pick<Opened, "imports" | "abandoned" | "self"> | undefined;
	await host.load(
		[
			{
				name: "notes",
				facet: defineFacet((h) =>
					h.serve(Store, (_, self) => {
						const imports = self.job(declared, {
							run,
							finish: async (outcome) => {
								finish?.(outcome);
								finished.push(outcome);
							},
						});
						const abandoned = self.job(Abandoned, {
							run: async () => ({ count: 0 }),
							finish: async (outcome) => void finished.push(outcome as unknown as ImportOutcome),
						});
						found = { imports, abandoned, self };
						return {};
					}),
				),
			},
		],
		context,
	);
	return {
		store,
		errors,
		finished,
		...found!,
		retry: async () => (await host.hold(Store, {}, context)).retry(),
		close: async () => {
			await host.close(context);
			await store.close(context);
		},
		crash: () => store.close(context),
	};
}

/** The stored revisions of the run state documents, in seq order: their kinds and contents. */
async function stateRevisions(store: ChordStore): Promise<[string, unknown][]> {
	const rows = await store.read(
		(executor) =>
			executor.all<{ kind: string; content: string }>(
				`SELECT r.kind, r.content FROM chord_revisions r JOIN chord_documents d ON d.id = r.document_id
					WHERE d.namespace = 'chord.job-states' ORDER BY r.seq`,
			),
		context,
	);
	return rows.map(({ kind, content }) => [kind, JSON.parse(content)]);
}

/** Waits `ms` of real time (a drain's bound passing, a wait that must not settle). */
function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The records the store keeps of `namespace`'s documents: their kinds and keys. */
async function stored(store: ChordStore, namespace: string): Promise<unknown[]> {
	return store.read(
		(executor) => executor.all("SELECT kind, key FROM chord_documents WHERE namespace = ? ORDER BY id", namespace),
		context,
	);
}

/** The current record of run `id`. */
async function record(store: ChordStore, id: string): Promise<Record<string, unknown> | undefined> {
	const row = await store.read(
		(executor) =>
			executor.get<{ content: string }>(
				`SELECT r.content FROM chord_revisions r JOIN chord_documents d ON d.id = r.document_id
					WHERE d.namespace = 'chord.jobs' AND d.key = ? ORDER BY r.seq DESC LIMIT 1`,
				id,
			),
		context,
	);
	return row === undefined ? undefined : (JSON.parse(row.content) as Record<string, unknown>);
}

describe("records", () => {
	it("a run's record and state live in the store while it is unsettled; finish deletes the record, retires the state", async () => {
		const open = await storeFile();
		const gate = Promise.withResolvers<void>();
		const jobs = await opened(await open(), async (_args, ctx) => {
			await ctx.state.change((draft) => {
				draft.done = 3;
			}, ctx);
			await gate.promise;
			return { count: 3 };
		});
		const run = await jobs.imports.start({ path: "a" }, context, { key: "k" });
		await delivered();
		expect(await stored(jobs.store, "chord.jobs")).toEqual([{ kind: "notes.import", key: run.id }]);
		expect(await stored(jobs.store, "chord.job-states")).toEqual([{ kind: "notes.import", key: run.id }]);
		expect(await record(jobs.store, run.id)).toMatchObject({
			phase: "running",
			restarts: 0,
			key: "k",
			args: { path: "a" },
		});
		gate.resolve();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: 3 }, state: { done: 3 } });
		expect(await stored(jobs.store, "chord.jobs")).toEqual([]);
		expect(await stored(jobs.store, "chord.job-states")).toEqual([]);
		await jobs.close();
	});
});

describe("crashes and restarts (D6)", () => {
	it("a run cut off while running is counted and rerun; a state change resets the count; five in a row end it", async () => {
		const open = await storeFile();
		const hang = (): Promise<never> => new Promise(() => {});
		let jobs = await opened(await open(), hang);
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		for (let restart = 1; restart < 5; restart++) {
			await jobs.crash();
			jobs = await opened(await open(), hang);
			await delivered();
			expect(await record(jobs.store, run.id)).toMatchObject({ phase: "running", restarts: restart });
		}
		await jobs.crash();
		jobs = await opened(await open(), hang);
		await delivered();
		await delivered();
		expect(jobs.finished).toMatchObject([{ kind: "failed", error: { kind: "restart_limit", restarts: 5 } }]);
		expect(jobs.errors).toContainEqual(
			expect.objectContaining({ kind: "job_interrupted", job: "notes.import", id: run.id, restarts: 5 }),
		);
		await jobs.close();
	});

	it("a state change resets the restart count, stored at once", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), () => new Promise(() => {}));
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.crash();
		jobs = await opened(await open(), async (_args, ctx) => {
			await ctx.state.change(
				(draft) => {
					draft.done = 1;
				},
				ctx,
				{ persistence: { kind: "deferred" } },
			);
			return new Promise(() => {});
		});
		await delivered();
		await delivered();
		expect(await record(jobs.store, run.id)).toMatchObject({ phase: "running", restarts: 0 });
		await jobs.crash();
	});

	it("abandon: a run cut off by a crash finishes failed { aborted, restart } without run", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), async () => ({ count: 0 }));
		const gate = Promise.withResolvers<void>();
		// Its run never returns before the crash.
		void gate;
		const run = await jobs.abandoned.start({ path: "a" }, context);
		await jobs.crash();
		jobs = await opened(await open(), async () => ({ count: 0 }));
		await delivered();
		await delivered();
		expect(jobs.finished.filter((outcome) => outcome.id === run.id)).toMatchObject([
			{ kind: "failed", error: { kind: "aborted", reason: "restart" } },
		]);
		await jobs.close();
	});
});

describe("versions", () => {
	it.each([
		["another version", ImportV2],
		["the same version with another fingerprint", ImportReshaped],
	])("a run stored by %s is blocked (version): kept as stored, never run, listed blocked", async (_, declared) => {
		const open = await storeFile();
		let jobs = await opened(await open(), () => new Promise(() => {}));
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.crash();
		let runs = 0;
		jobs = await opened(
			await open(),
			async () => {
				runs++;
				return { count: 1 };
			},
			undefined,
			declared,
		);
		await delivered();
		expect(runs).toBe(0);
		expect(jobs.imports.running.value).toEqual([{ id: run.id, version: 1, phase: "blocked", reason: "version" }]);
		// Kept as stored: the crash is not counted, slice 7 maps or resolves it.
		expect(await record(jobs.store, run.id)).toMatchObject({ version: 1, phase: "running", restarts: 0 });
		await jobs.close();
	});
});

describe("versions with incompatible state (review regression)", () => {
	it("a run of another version is blocked before its state is decoded: no migration, no activation failure", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), () => new Promise(() => {}));
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.crash();
		const changed = defineState("import.progress", {
			schema: obj({ done: str() }),
			version: 2,
			initial: () => ({ done: "new" }),
			persist: true,
			checkpointWhen: () => false,
			migrate: () => {
				throw new Error("must not migrate an unsupported run");
			},
		});
		const declared = defineJob("notes.import", { ...importOptions(), version: 2, state: changed });
		// The declaration's state type differs from `Import`'s: this host only lists the blocked run.
		jobs = await opened(await open(), async () => ({ count: 0 }), undefined, declared as unknown as typeof Import);
		expect(jobs.errors).toEqual([]);
		expect(jobs.imports.running.value).toEqual([{ id: run.id, version: 1, phase: "blocked", reason: "version" }]);
		// An abort drops it: its record and its undecoded state document are retired.
		expect(await jobs.imports.abort(run.id, context)).toBe("marked");
		expect(await stored(jobs.store, "chord.jobs")).toEqual([]);
		expect(await stored(jobs.store, "chord.job-states")).toEqual([]);
		await jobs.close();
	});
});

describe("versions without a state (review regression)", () => {
	it("an abort of a run blocked under a version without a state retires the old state document too", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), () => new Promise(() => {}));
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.crash();
		const stateless = defineJob("notes.import", { ...importOptions(), version: 2, state: undefined });
		// The declaration's state type differs from `Import`'s: this host only lists and drops the blocked run.
		jobs = await opened(await open(), async () => ({ count: 0 }), undefined, stateless as unknown as typeof Import);
		expect(jobs.imports.running.value).toEqual([{ id: run.id, version: 1, phase: "blocked", reason: "version" }]);
		expect(await jobs.imports.abort(run.id, context)).toBe("marked");
		expect(await stored(jobs.store, "chord.jobs")).toEqual([]);
		expect(await stored(jobs.store, "chord.job-states")).toEqual([]);
		await jobs.close();
	});
});

describe("a seal during the reservation (review regressions)", () => {
	it("a reservation refused at admission after the seal: the next live attempt invokes the run", async () => {
		const open = await storeFile();
		let invoked = 0;
		const jobs = await opened(await open(), async () => ({ count: ++invoked }));
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const commit = jobs.store.commit.bind(jobs.store);
		let commits = 0;
		// The second commit is the reservation: it reaches the store only after the seal.
		jobs.store.commit = (writes, fence, ctx) => {
			if (++commits !== 2) return commit(writes, fence, ctx);
			entered.resolve();
			return gate.promise.then(() => commit(writes, fence, ctx));
		};
		const run = await jobs.imports.start({ path: "p" }, context);
		await entered.promise;
		failLive(attempted, jobs.self, new ChordError({ code: "unavailable", message: "seal during reservation" }));
		await jobs.retry();
		gate.resolve();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: 1 } });
		expect(invoked).toBe(1);
		await jobs.close();
	});

	it("a reservation queued behind a held commit queue past the seal: the next live attempt invokes the run", async () => {
		const open = await storeFile();
		let invoked = 0;
		const jobs = await opened(await open(), async () => ({ count: ++invoked }));
		const held = Promise.withResolvers<() => void>();
		const commit = jobs.store.commit.bind(jobs.store);
		let first = true;
		// The start's commit takes the queue as it adopts (an export would): the reservation waits behind it.
		jobs.store.commit = (writes, fence, ctx) => {
			if (!first) return commit(writes, fence, ctx);
			first = false;
			const holding = {
				admit: () => fence.admit(),
				adopt: (seq: number, ids: readonly number[]) => {
					fence.adopt(seq, ids);
					void jobs.store.take(() => {}).then(held.resolve);
				},
			};
			return commit(writes, holding, ctx);
		};
		const run = await jobs.imports.start({ path: "p" }, context);
		const release = await held.promise;
		await delivered();
		failLive(attempted, jobs.self, new ChordError({ code: "unavailable", message: "seal queued reservation" }));
		await jobs.retry();
		release();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: 1 } });
		expect(invoked).toBe(1);
		await jobs.close();
	});

	it("an abort joined to a reservation that commits after the seal returns marked", async () => {
		const open = await storeFile();
		const jobs = await opened(await open(), async () => ({ count: 1 }));
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const commit = jobs.store.commit.bind(jobs.store);
		let commits = 0;
		// The reservation's commit is admitted, then held past the seal (its continuation sees the attempt sealed).
		jobs.store.commit = (writes, fence, ctx) => {
			const committed = commit(writes, fence, ctx);
			if (++commits !== 2) return committed;
			entered.resolve();
			return committed.then(async (seq) => {
				await gate.promise;
				return seq;
			});
		};
		const run = await jobs.imports.start({ path: "p" }, context);
		await entered.promise;
		const aborting = jobs.imports.abort(run.id, context);
		await delivered();
		failLive(attempted, jobs.self, new ChordError({ code: "unavailable", message: "seal after reservation" }));
		gate.resolve();
		expect(await aborting).toBe("marked");
		await jobs.close();
	});
});

describe("the clean stop and the close writer", () => {
	it("host close writes the stopped runs back: the next start resumes them without counting", async () => {
		const open = await storeFile();
		let jobs = await opened(
			await open(),
			(_args, ctx) =>
				new Promise((_, reject) => ctx.abortSignal?.addEventListener("abort", () => reject(new Error("stopped")))),
		);
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.close();
		const reopened = await open();
		expect(await record(reopened, run.id)).toMatchObject({ phase: "stopped", restarts: 0 });
		jobs = await opened(reopened, async () => ({ count: 7 }));
		await delivered();
		await delivered();
		expect(jobs.finished).toMatchObject([{ kind: "done", result: { count: 7 } }]);
		await jobs.close();
	});

	it("a seal (a live failure) stops the run; the retry resumes it once its old invocation settled, uncounted (R3)", async () => {
		const open = await storeFile();
		let invocations = 0;
		const old = Promise.withResolvers<void>();
		const jobs = await opened(await open(), async () => {
			invocations++;
			if (invocations === 1) {
				// Ignores its signal until released.
				await old.promise;
				return { count: -1 };
			}
			return { count: invocations };
		});
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		failLive(attempted, jobs.self, new ChordError({ code: "unavailable", message: "boom" }));
		await jobs.retry();
		await delivered();
		// The retry waits for the old invocation (the drain, bounded by closeTimeout): no second run beside it.
		expect(invocations).toBe(1);
		old.resolve();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: 2 } });
		expect(jobs.finished.map(({ kind }) => kind)).toEqual(["done"]);
		await jobs.close();
	});

	it("a close writer that cannot commit leaves the records running: the next start counts a restart", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), () => new Promise(() => {}));
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.crash();
		await jobs.close();
		jobs = await opened(await open(), () => new Promise(() => {}));
		await delivered();
		expect(await record(jobs.store, run.id)).toMatchObject({ phase: "running", restarts: 1 });
		await jobs.crash();
	});
});

describe("invocations after a seal (R3, review regressions)", () => {
	/** A store object whose first invocation ignores its signal until `old` resolves, the next ones run `next`. */
	async function sealed(next: (ctx: { readonly abortSignal?: AbortSignal }) => Promise<ImportResult>) {
		const open = await storeFile();
		const old = Promise.withResolvers<void>();
		const signals: boolean[] = [];
		let invocations = 0;
		const jobs = await opened(await open(), async (_args, ctx) => {
			signals.push(ctx.abortSignal?.aborted ?? false);
			if (++invocations > 1) return next(ctx);
			await old.promise;
			const wrote = await ctx.state
				.change((draft) => {
					draft.done = 99;
				}, ctx)
				.then(
					() => "accepted",
					(error: unknown) => error,
				);
			return { count: wrote === "accepted" ? -2 : -1 };
		});
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		failLive(attempted, jobs.self, new ChordError({ code: "unavailable", message: "boom" }));
		return { jobs, run, old, signals, invocations: () => invocations };
	}

	it("an invocation replaced after the bounded drain writes nothing and records nothing", async () => {
		const current = Promise.withResolvers<void>();
		const { jobs, run, old, invocations } = await sealed(async () => {
			await current.promise;
			return { count: 2 };
		});
		await jobs.retry();
		// The drain (closeTimeout 200 ms) ends without the old invocation: the retry invokes the run again.
		await sleepMs(300);
		expect(invocations()).toBe(2);
		old.resolve();
		await delivered();
		await delivered();
		expect(jobs.finished).toEqual([]);
		expect(jobs.imports.running.value).toMatchObject([{ id: run.id, state: { done: 0 } }]);
		current.resolve();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: 2 } });
		await jobs.close();
	});

	it("a resumed invocation gets a fresh abort signal", async () => {
		const { jobs, run, old, signals } = await sealed(async () => ({ count: 1 }));
		await jobs.retry();
		old.resolve();
		await run.outcome(context);
		expect(signals).toEqual([false, false]);
		await jobs.close();
	});

	it("abort joins the resumed invocation, not the first", async () => {
		const second = Promise.withResolvers<void>();
		const { jobs, run, old } = await sealed(async () => {
			await second.promise;
			return { count: 2 };
		});
		old.resolve();
		await jobs.retry();
		await sleepMs(20);
		let settled = false;
		const aborting = jobs.imports.abort(run.id, context).then((answer) => {
			settled = true;
			return answer;
		});
		await sleepMs(50);
		expect(settled).toBe(false);
		second.resolve();
		expect(await aborting).toBe("marked");
		await jobs.close();
	});

	it("resume abandon: a run the seal stopped finishes failed { aborted, restart } without a second run", async () => {
		const open = await storeFile();
		const old = Promise.withResolvers<void>();
		let calls = 0;
		const declared = defineJob("notes.import", { ...importOptions(), persist: { resume: "abandon" } });
		const jobs = await opened(
			await open(),
			async () => {
				calls++;
				if (calls === 1) await old.promise;
				return { count: calls };
			},
			undefined,
			declared,
		);
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		failLive(attempted, jobs.self, new ChordError({ code: "unavailable", message: "boom" }));
		await jobs.retry();
		old.resolve();
		expect(await run.outcome(context)).toMatchObject({
			kind: "failed",
			error: { kind: "aborted", reason: "restart" },
		});
		expect(calls).toBe(1);
		await jobs.close();
	});
});

describe("loading (review regressions)", () => {
	it("a refused recovery commit loses nothing: the retry loads the runs again and counts the crash once", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), () => new Promise(() => {}));
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.crash();
		const store = await open();
		const refused = vi.spyOn(store, "commit").mockRejectedValueOnce(new Error("refused recovery"));
		let invocations = 0;
		jobs = await opened(store, () => {
			invocations++;
			return new Promise(() => {});
		});
		expect(jobs.errors).toContainEqual(expect.objectContaining({ kind: "activation_failed" }));
		refused.mockRestore();
		await jobs.retry();
		await delivered();
		await delivered();
		expect(invocations).toBe(1);
		expect(jobs.imports.running.value).toMatchObject([{ id: run.id }]);
		expect(await record(store, run.id)).toMatchObject({ phase: "running", restarts: 1 });
		await jobs.close();
	});

	it("a state document that fails to load fails the activation; the retry with fixed code loads the run", async () => {
		const open = await storeFile();
		const hang = (): Promise<never> => new Promise(() => {});
		const failing = { fail: true };
		const ProgressV2 = defineState("import.progress", {
			schema: obj({ done: int() }),
			version: 2,
			migrate: (old) => {
				if (failing.fail) throw new Error("migrate failed");
				return old as { done: number };
			},
			initial: () => ({ done: 0 }),
			persist: true,
			checkpointWhen: () => false,
		});
		let jobs = await opened(await open(), hang);
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await jobs.crash();
		jobs = await opened(
			await open(),
			hang,
			undefined,
			defineJob("notes.import", { ...importOptions(), state: ProgressV2 }),
		);
		expect(jobs.errors.map(({ kind }) => kind)).toContain("activation_failed");
		failing.fail = false;
		await jobs.retry();
		await delivered();
		expect(jobs.imports.running.value).toMatchObject([{ id: run.id, state: { done: 0 } }]);
		await jobs.close();
	});
});

describe("finish failures", () => {
	it("are counted on the record, across a crash", async () => {
		const open = await storeFile();
		let jobs = await opened(
			await open(),
			async () => ({ count: 1 }),
			() => {
				throw new Error("finish failed");
			},
		);
		const run = await jobs.imports.start({ path: "a" }, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await record(jobs.store, run.id)).toMatchObject({ phase: "finishing", finishFailures: 1 });
		await jobs.crash();
		const failing = () => {
			throw new Error("finish failed");
		};
		jobs = await opened(await open(), async () => ({ count: 1 }), failing);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await record(jobs.store, run.id)).toMatchObject({ phase: "finishing", finishFailures: 2 });
		await jobs.crash();
		jobs = await opened(await open(), async () => ({ count: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(jobs.finished).toMatchObject([{ kind: "done", result: { count: 1 } }]);
		await jobs.close();
	});
});

describe("abort (D7)", () => {
	it("is stored and joined: marked once run settled, terminal for an unknown id", async () => {
		const open = await storeFile();
		const jobs = await opened(
			await open(),
			(_args, ctx) =>
				new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve({ count: -1 }))),
		);
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		expect(await jobs.imports.abort(run.id, context)).toBe("marked");
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: -1 } });
		expect(await jobs.imports.abort(run.id, context)).toBe("terminal");
		await jobs.close();
	});

	it("an abort-marked run not invoked yet finishes aborted without run after a crash", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), () => new Promise(() => {}));
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		const aborting = jobs.imports.abort(run.id, context);
		await delivered();
		await jobs.crash();
		void aborting.catch(() => {});
		let ran = false;
		jobs = await opened(await open(), async () => {
			ran = true;
			return { count: 1 };
		});
		await delivered();
		await delivered();
		expect(ran).toBe(false);
		expect(jobs.finished).toMatchObject([{ kind: "failed", error: { kind: "aborted", reason: "abort" } }]);
		await jobs.close();
	});
});

describe("abort of a finishing run (review regression)", () => {
	it("stores the mark and keeps the recorded outcome", async () => {
		const open = await storeFile();
		const jobs = await opened(
			await open(),
			async () => ({ count: 1 }),
			() => {
				throw new Error("retry finish");
			},
		);
		const run = await jobs.imports.start({ path: "a" }, context);
		await sleepMs(50);
		expect(await record(jobs.store, run.id)).toMatchObject({ phase: "finishing" });
		expect(await jobs.imports.abort(run.id, context)).toBe("marked");
		expect(await record(jobs.store, run.id)).toMatchObject({
			phase: "finishing",
			abort: true,
			outcome: { kind: "done", result: { count: 1 } },
		});
		await jobs.crash();
	});
});

describe("abort racing an outcome", () => {
	it("an abort that comes as run returns keeps its result: marked or terminal, the outcome done", async () => {
		const open = await storeFile();
		const jobs = await opened(await open(), async () => ({ count: 5 }));
		const run = await jobs.imports.start({ path: "a" }, context);
		const aborted = await jobs.imports.abort(run.id, context);
		expect(["marked", "terminal"]).toContain(aborted);
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: 5 } });
		await jobs.close();
	});
});

describe("pinning", () => {
	it("an unsettled run's state never idles: past the residency retention it is in memory, read synchronously", async () => {
		const open = await storeFile();
		const touched = vi.spyOn(Residency.prototype, "touch");
		const gate = Promise.withResolvers<void>();
		const values: number[] = [];
		const jobs = await opened(await open(), async (_args, ctx) => {
			await ctx.state.change((draft) => {
				draft.done = 3;
			}, ctx);
			await gate.promise;
			values.push(ctx.state.value.done);
			return { count: ctx.state.value.done };
		});
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		try {
			vi.advanceTimersByTime(2 * RETENTION_MS);
		} finally {
			vi.useRealTimers();
		}
		await delivered();
		// The run's documents never entered the idle structure the retention evicts from.
		expect(touched).not.toHaveBeenCalled();
		expect(jobs.imports.running.value).toMatchObject([{ id: run.id, state: { done: 3 } }]);
		gate.resolve();
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: { count: 3 } });
		expect(values).toEqual([3]);
		touched.mockRestore();
		await jobs.close();
	});
});

describe("deferred state (D8)", () => {
	it("is adopted at once, held, and stored with the outcome", async () => {
		const open = await storeFile();
		const gate = Promise.withResolvers<void>();
		let seen: number | undefined;
		const jobs = await opened(await open(), async (_args, ctx) => {
			await ctx.state.change(
				(draft) => {
					draft.done = 1;
				},
				ctx,
				{
					persistence: { kind: "deferred", withinMs: Infinity },
				},
			);
			seen = ctx.state.value.done;
			await gate.promise;
			return { count: 1 };
		});
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		expect(seen).toBe(1);
		const state = await jobs.store.read(
			(executor) =>
				executor.all(
					"SELECT r.kind FROM chord_revisions r JOIN chord_documents d ON d.id = r.document_id WHERE d.namespace = 'chord.job-states'",
				),
			context,
		);
		expect(state).toEqual([{ kind: "base" }]);
		gate.resolve();
		expect(await run.outcome(context)).toMatchObject({ state: { done: 1 } });
		await jobs.close();
	});

	it("merges held ops into the next immediate change: one delta on the stored revision", async () => {
		const open = await storeFile();
		const gate = Promise.withResolvers<void>();
		const jobs = await opened(await open(), async (_args, ctx) => {
			const deferred = { persistence: { kind: "deferred", withinMs: Infinity } } as const;
			await ctx.state.change(
				(draft) => {
					draft.done = 1;
				},
				ctx,
				deferred,
			);
			await ctx.state.change(
				(draft) => {
					draft.done = 2;
				},
				ctx,
				deferred,
			);
			await ctx.state.change((draft) => {
				draft.done = 3;
			}, ctx);
			await gate.promise;
			return { count: 3 };
		});
		const run = await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await delivered();
		const revisions = await jobs.store.read(
			(executor) =>
				executor.all<{ kind: string; content: string }>(
					"SELECT r.kind, r.content FROM chord_revisions r JOIN chord_documents d ON d.id = r.document_id WHERE d.namespace = 'chord.job-states' ORDER BY r.seq",
				),
			context,
		);
		expect(revisions.map(({ kind, content }) => [kind, JSON.parse(content)])).toEqual([
			["base", { done: 0 }],
			[
				"delta",
				// The held sets of one leaf folded (`PendingOps`), then the change's own.
				[
					["s", ["done"], 2],
					["s", ["done"], 3],
				],
			],
		]);
		gate.resolve();
		await run.outcome(context);
		await jobs.close();
	});

	it("folds held writes: 100 sets of one leaf keep one op; past the pending bound the next change stores a base", async () => {
		const open = await storeFile();
		const store = await open();
		const changed = Promise.withResolvers<void>();
		const deferred = { persistence: { kind: "deferred", withinMs: Infinity } } as const;
		const jobs = await opened(store, async (_args, ctx) => {
			for (let n = 1; n <= 100; n++) {
				await ctx.state.change(
					(draft) => {
						draft.done = n;
					},
					ctx,
					deferred,
				);
			}
			await ctx.state.change((draft) => {
				draft.done = 101;
			}, ctx);
			changed.resolve();
			return new Promise(() => {});
		});
		await jobs.imports.start({ path: "a" }, context);
		await changed.promise;
		expect((await stateRevisions(store)).at(-1)).toEqual([
			"delta",
			[
				["s", ["done"], 100],
				["s", ["done"], 101],
			],
		]);
		await jobs.close();
	});

	it("an overflow of held ops stores the next change as a base", async () => {
		const open = await storeFile();
		const store = await open();
		const Items = defineState("import.progress", {
			schema: obj({ done: int(), items: arr(int()) }),
			version: 1,
			initial: () => ({ done: 0, items: new Array<number>(MAX_PENDING_OPS + 2).fill(0) }),
			persist: true,
			checkpointWhen: () => false,
		});
		const declared = defineJob("notes.import", { ...importOptions(), state: Items });
		const changed = Promise.withResolvers<void>();
		const deferred = { persistence: { kind: "deferred", withinMs: Infinity } } as const;
		// The declaration's state type differs from `Import`'s; this run writes only `Items`' shape.
		const jobs = await opened(
			store,
			async (_args, ctx) => {
				const state = ctx.state as unknown as RunState<{ done: number; items: number[] }>;
				// One leaf each: nothing folds, and the queue passes its bound.
				for (let n = 0; n <= MAX_PENDING_OPS; n++) {
					await state.change(
						(draft) => {
							draft.items[n] = 1;
						},
						ctx,
						deferred,
					);
				}
				await state.change((draft) => {
					draft.done = 1;
				}, ctx);
				changed.resolve();
				return new Promise(() => {});
			},
			undefined,
			declared as unknown as typeof Import,
		);
		await jobs.imports.start({ path: "a" }, context);
		await changed.promise;
		// A new base prunes the older revisions (`history: none`): the start's base is gone.
		expect(await stateRevisions(store)).toEqual([["base", expect.objectContaining({ done: 1 })]]);
		await jobs.close();
	});

	it("is stored by the close writer at a clean stop, and after withinMs by the object's timer", async () => {
		const open = await storeFile();
		let jobs = await opened(await open(), async (_args, ctx) => {
			await ctx.state.change(
				(draft) => {
					draft.done = 4;
				},
				ctx,
				{ persistence: { kind: "deferred", withinMs: Infinity } },
			);
			return new Promise(() => {});
		});
		await jobs.imports.start({ path: "a" }, context);
		await delivered();
		await delivered();
		await jobs.close();
		jobs = await opened(await open(), async (_args, ctx) => {
			expect(ctx.state.value).toEqual({ done: 4 });
			await ctx.state.change(
				(draft) => {
					draft.done = 5;
				},
				ctx,
				{ persistence: { kind: "deferred", withinMs: 10 } },
			);
			return new Promise(() => {});
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		await jobs.crash();
		jobs = await opened(await open(), async (_args, ctx) => {
			expect(ctx.state.value).toEqual({ done: 5 });
			return { count: 0 };
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(jobs.finished).toMatchObject([{ kind: "done", state: { done: 5 } }]);
		await jobs.close();
	});

	it("refuses a negative withinMs", async () => {
		const open = await storeFile();
		let refused: unknown;
		const jobs = await opened(await open(), async (_args, ctx) => {
			refused = await ctx.state
				.change(() => {}, ctx, { persistence: { kind: "deferred", withinMs: -1 } })
				.catch((error: unknown) => error);
			return { count: 0 };
		});
		const run = await jobs.imports.start({ path: "a" }, context);
		await run.outcome(context);
		expect(refused).toMatchObject({ code: "invalid", reason: "args" });
		await jobs.close();
	});
});

describe("GC", () => {
	const runs = instancesOf(JobRun, "entryFor");

	it("settled runs, cancelled abort waits, and an ended object with a held change and its timer are collected", async () => {
		const open = await storeFile();
		/** Runs one settled run and leaves one held change behind a closed host: what must be collected. */
		const ended = async (): Promise<WeakRef<object>[]> => {
			// Earlier tests leave crashed hosts behind: only this one's objects and runs count.
			runs.splice(0);
			attempted.splice(0);
			const jobs = await opened(await open(), async (_args, ctx) => {
				await ctx.state.change(
					(draft) => {
						draft.done = 1;
					},
					ctx,
					{ persistence: { kind: "deferred", withinMs: 60_000 } },
				);
				return new Promise(() => {});
			});
			const settled = await jobs.abandoned.start({ path: "a" }, context);
			await settled.outcome(context);
			await jobs.imports.start({ path: "b" }, context);
			await delivered();
			await delivered();
			const refs = [...runs.splice(0), ...attempted.splice(0)];
			await jobs.close();
			return refs;
		};
		await expectCollected(...(await ended()));
		const hanging = await opened(await open(), () => new Promise(() => {}));
		const run = await hanging.imports.start({ path: "c" }, context);
		await delivered();
		const cancel = withCancel(context);
		let waiting: Promise<unknown> | undefined = hanging.imports.abort(run.id, cancel.context).catch(() => {});
		const waitRef = new WeakRef(waiting);
		await delivered();
		cancel.cancel();
		await waiting;
		waiting = undefined;
		await expectCollected(waitRef);
		await hanging.close();
	});
});
