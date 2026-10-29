// A job's records on its object (§15, slice 6a §1.2, slice 6b §4): its runs by id and by key, the active count, the
// run state documents, `running` and the runs waiting for a live attempt, across the object's attempts. Records and
// state documents change only in transactions on the object's line (staged changes adopted in the commit step); a
// persisted job's also in its object's store, in the same commits, loaded once per object, and written back stopped by
// the close writer when a clean stop cuts its runs off.

import { type Context, withoutAbortSignal } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import { ChordError } from "../data/index.ts";
import { check, validatorFor } from "../data/internal.ts";
import type { JsonObject } from "../documents/index.ts";
import { type Documents, Persistence, type Staged, type Transaction } from "../documents/internal.ts";
import type { AnyHost } from "../host/internal.ts";
import { uuidv7 } from "../host/internal.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ChordStore } from "../store/store.ts";
import type { JobDefinition, JobError } from "./definition.ts";
import type { Job, StartOptions } from "./job.ts";
import { type LoadedRecord, PersistedRuns } from "./persisted.ts";
import { type AnyOutcome, type BlockedReason, JobRun, type Phase, type Run } from "./run.ts";
import { RunStates } from "./run-states.ts";
import { Running } from "./running.ts";
import { outcomeOf, type StoredFields, storedRun } from "./stored.ts";

/** What a job's records need of their object. */
export type RecordsOwner = {
	readonly label: string;
	readonly host: AnyHost;
	/** The object's context, without an abort signal: outcomes are recorded under it. */
	readonly context: Context;
	readonly documents: Documents;
	/** The host's store and the object's owner name in it, when the object may persist (P3). */
	readonly store: { readonly store: ChordStore; readonly owner: string } | undefined;
	/** Counts running and finishing runs: they keep the object alive (`host.activity.jobs`). */
	countRuns(delta: number): void;
	/** A held state change must be stored by `deadline`: the object's one timer flushes it (D8). */
	held(deadline: number): void;
};

/** How a run's invocation ended, before its outcome is recorded. */
export type Settled =
	| { readonly kind: "done"; readonly result: unknown }
	| { readonly kind: "failed"; readonly error: JobError };

/** What a change sets on a run's record besides its phase transitions below (D6, D7, the finish failure count). */
type RunFields = {
	readonly phase?: Phase;
	readonly restarts?: number;
	readonly finishFailures?: number;
	readonly abortMarked?: true;
};

/** A loaded run and the change its activation writes, if any. */
type Restored = { readonly run: JobRun; readonly change: RecordChange | undefined };

/** A change of the records, staged in a transaction and adopted in its commit step. */
type RecordChange =
	| { readonly kind: "create"; readonly run: JobRun }
	| { readonly kind: "update"; readonly run: JobRun; readonly fields: RunFields }
	| { readonly kind: "outcome"; readonly run: JobRun; readonly outcome: AnyOutcome }
	| { readonly kind: "block"; readonly run: JobRun; readonly reason: BlockedReason }
	| { readonly kind: "delete"; readonly run: JobRun }
	| { readonly kind: "drop"; readonly run: JobRun };

/** What a commit step adopts of the records: a change, or a loaded run taken into memory as stored. */
type Adopted = RecordChange | { readonly kind: "restore"; readonly run: JobRun };

/** One transaction's changes of one job: the runs it started (dedupe, concurrency) and whose finish it is. */
export type Staging = Staged & {
	readonly started: JobRun[];
	readonly changes: Adopted[];
	/** What the transaction's store writes leave in memory, adopted with the changes. */
	readonly adopts: (() => void)[];
	finishing: JobRun | undefined;
};

const RESTART: Settled = { kind: "failed", error: { kind: "aborted", reason: "restart" } };

const ABORTED: Settled = { kind: "failed", error: { kind: "aborted", reason: "abort" } };

/** A persisted run cut off this many times in a row ends `restart_limit` (D6, Durable's limit). */
const RESTART_LIMIT = 5;

/**
 * The records of one job name on one object. The live attempt's `Job` invokes and finishes its runs; between live
 * attempts, committed runs not yet invoked and runs whose outcome is recorded wait for the next one.
 */
export class JobRecords {
	readonly definition: JobDefinition<unknown, unknown, unknown>;
	readonly running: Running;
	readonly #owner: RecordsOwner;
	readonly #states: RunStates | undefined;
	/** The store side of a persisted job's runs; `undefined` in memory. */
	readonly #persisted: PersistedRuns | undefined;
	readonly #runs = new Map<string, JobRun>();
	readonly #keys = new Map<string, JobRun>();
	/** Running and finishing runs: concurrency and keep-alive count them. */
	#active = 0;
	/** The live attempt's job; `undefined` between live attempts. */
	#job: Job | undefined;
	/** Runs waiting for a live attempt: to be invoked (`invocation` pending) or finished (phase `finishing`). */
	readonly #waiting = new Set<JobRun>();
	/** Runs a clean stop cut off whose record the close writer has not written `stopped` yet. */
	readonly #stopped = new Set<JobRun>();
	/** Whether a persisted job's records were loaded (once per object). */
	#loaded = false;
	/** The object's end error, once it ended. */
	#ended: ChordError | undefined;

	constructor(definition: JobDefinition<unknown, unknown, unknown>, owner: RecordsOwner) {
		this.definition = definition;
		this.#owner = owner;
		const { state, persist, name } = definition;
		const store = persist === undefined ? undefined : owner.store!;
		const states = {
			documents: owner.documents,
			changed: (id: string, ops: readonly Op[]) => this.#stateChanged(id, ops),
			held: (deadline: number) => owner.held(deadline),
		};
		const persistence =
			store === undefined ? undefined : new Persistence(store.store, store.owner, "chord.job-states", name);
		this.#states = state === undefined ? undefined : new RunStates(state, states, persistence);
		this.#persisted =
			store === undefined
				? undefined
				: new PersistedRuns(new Persistence(store.store, store.owner, "chord.jobs", name), persistence!);
		this.running = new Running(owner.documents.batch, this.name);
	}

	/** The job in errors: its object and its name. */
	get name(): string {
		return `${this.#owner.label} job ${this.definition.name}`;
	}

	/** Waits for the outcome of the unsettled run `id`; a settled or unknown id rejects `gone`. */
	outcome(id: string, context: Context): Promise<AnyOutcome> {
		const run = this.#runs.get(id);
		if (run === undefined) {
			return Promise.reject(new ChordError({ code: "gone", message: `${this.name}: no unsettled run ${id}` }));
		}
		return run.handle.outcome(context);
	}

	/**
	 * Aborts run `id` (D7, Durable's `abortTask`): a blocked run is dropped; a finishing one is only marked; any other
	 * is marked (stored for a persisted job) in a transaction, its signal fired after the commit, outside the batch and
	 * the line, and the abort joins its invocation. `"marked"`, or `"terminal"` when no unsettled run has that id.
	 */
	async abort(id: string, context: Context): Promise<"marked" | "terminal"> {
		const run = this.#runs.get(id);
		if (run === undefined || this.#ended !== undefined) return "terminal";
		if (run.phase === "blocked") {
			await this.record(run, { kind: "drop", run });
			return "marked";
		}
		if (!run.abortMarked) await this.record(run, { kind: "update", run, fields: { abortMarked: true } });
		// A finishing run's outcome stays: it is only marked.
		if (run.phase === "finishing") return "marked";
		run.invocation?.abort.abort(new ChordError({ code: "aborted", message: `${this.name}: run ${id} aborted` }));
		await run.over(context);
		return "marked";
	}

	/** See `Job.stage`: the checks and the staged creation, against the object's runs. */
	stage(tx: Transaction, args: unknown, context: Context, options: StartOptions): Run<AnyOutcome> {
		const definition = this.definition;
		// Plugin code, not type-checked: the args are checked as a method's are (R7).
		check(validatorFor(definition.args, context), args, "args", context);
		const staged = tx.staged<Staging>(this);
		const { key } = options;
		if (key !== undefined) {
			const known = staged?.started.find((run) => run.key === key) ?? this.#keys.get(key);
			if (known !== undefined && known !== staged?.finishing) return known.handle;
		}
		const { concurrency } = definition;
		const active = this.#active + (staged?.started.length ?? 0) - (staged?.finishing === undefined ? 0 : 1);
		if (concurrency !== undefined && active >= concurrency) {
			const message = `${this.name}: at its concurrency limit (${concurrency})`;
			throw new ChordError({ code: "unavailable", reason: "busy", message });
		}
		const persisted = this.#persisted !== undefined;
		const trace = persisted ? context.telemetry.propagation?.inject(context.telemetry) : undefined;
		// Checked above: the args are JSON (the definition refuses bytes).
		const run = new JobRun(
			uuidv7(),
			definition.version,
			key,
			args as JsonValue,
			persisted ? "pending" : "running",
			trace,
		);
		const staging = this.staging(tx);
		staging.started.push(run);
		this.change(tx, { kind: "create", run });
		const state = definition.state?.initial(context);
		if (state !== undefined) staging.adopts.push(this.#states!.stageCreate(run.id, state, () => this.#store(tx)));
		return run.handle;
	}

	/**
	 * Stages `change` in `tx`: in the job's staging, adopted in the commit step, and for a persisted job the run's record
	 * written with it (rule 8: serialized now), and for a settled run its state document retired.
	 */
	change(tx: Transaction, change: RecordChange): void {
		const staging = this.staging(tx);
		staging.changes.push(change);
		const { run } = change;
		const states = this.#states;
		const retires = change.kind === "delete" || change.kind === "drop";
		if (retires && states?.current(run.id) !== undefined) tx.retireSlot(states, run.id);
		const persisted = this.#persisted;
		if (persisted === undefined) return;
		const writes = this.#store(tx);
		if (retires) {
			staging.adopts.push(persisted.stageRetire(run.id, writes));
			return;
		}
		const fields = recordFields(change);
		staging.adopts.push(persisted.stage(run.id, storedRun(run, this.definition.fingerprint, fields), writes));
	}

	/** This job's changes in `tx`, made on the first. */
	staging(tx: Transaction): Staging {
		return tx.stage(this, () => {
			const changes: Adopted[] = [];
			const adopts: (() => void)[] = [];
			return {
				started: [],
				changes,
				adopts,
				finishing: undefined,
				adopt: () => {
					// A step admitted before the object ended adopts after it: the records are not changed any more.
					if (this.#ended !== undefined) return;
					// What is stored first: a new run's state document exists when its `running` entry is made.
					runAll(adopts);
					for (const change of changes) this.#adopt(change);
				},
				committed: () => {
					const ended = this.#ended;
					if (ended === undefined) {
						for (const change of changes) this.#committed(change);
						return;
					}
					// Its runs end as the object's other runs did.
					for (const change of changes) if (change.kind === "create") change.run.reject(ended);
				},
				discarded: () => {
					for (const change of changes) if (change.kind === "create") change.run.reject(this.#discarded());
				},
			};
		});
	}

	/**
	 * A persisted job's runs, loaded once per object at its first activation (slice 6b §4.2), again only after a load
	 * failed (design §9): each record read; a record of another version or fingerprint blocked (`version`) as stored,
	 * its state document left undecoded; the others' state documents read and decoded, a run cut off while `running`
	 * counted (`restarts + 1`; at the limit it ends `restart_limit`, reported `job_interrupted`), `stopped` and
	 * `pending` ones made `pending` again. The runs and their activation changes are adopted in one commit, all before
	 * anything runs; a failure leaves nothing loaded.
	 */
	async load(context: Context): Promise<void> {
		const persisted = this.#persisted;
		if (persisted === undefined || this.#loaded) return;
		const restored: Restored[] = [];
		try {
			for (const loaded of await persisted.load(context)) restored.push(await this.#restored(loaded, context));
			if (restored.length > 0) {
				const { documents } = this.#owner;
				await documents.tx((tx) => this.#restoreAll(tx, restored), documents.own, context);
			}
		} catch (error) {
			persisted.drop();
			for (const { run } of restored) this.#states?.retire(run.id);
			throw error;
		}
		this.#loaded = true;
		for (const { run, change } of restored) {
			if (
				change?.kind === "outcome" &&
				change.outcome.kind === "failed" &&
				change.outcome.error.kind === "restart_limit"
			) {
				this.report({ kind: "job_interrupted", id: run.id, restarts: change.outcome.error.restarts });
			}
		}
		for (const { run } of restored) this.#need(run);
	}

	/** Stages the loaded runs in `tx`: each restored, then the activation changes (adopted after every restore). */
	#restoreAll(tx: Transaction, restored: readonly Restored[]): void {
		const staging = this.staging(tx);
		for (const { run } of restored) staging.changes.push({ kind: "restore", run });
		for (const { change } of restored) if (change !== undefined) this.change(tx, change);
	}

	/** `job`, of the attempt that went live, invokes and finishes the runs from now on; the waiting ones first. */
	attach(job: Job): void {
		if (this.#ended !== undefined) return;
		this.#job = job;
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		for (const run of waiting) this.#dispatch(run, job);
	}

	/**
	 * `job`'s attempt was sealed: its running invocations are cut off (`cut`), the runs it was finishing wait for the
	 * next live attempt.
	 */
	detach(job: Job, finishing: Iterable<JobRun>): void {
		if (this.#job === job) this.#job = undefined;
		for (const run of finishing) this.#need(run);
	}

	/**
	 * A run whose reservation its sealed attempt never committed waits for the next live attempt (dispatched now when one
	 * is attached already: the sealed attempt was detached at its seal).
	 */
	requeue(run: JobRun): void {
		this.#need(run);
	}

	/** Records `run` running before its `run` is invoked (a persisted run's reservation: a crash after it counts). */
	reserve(tx: Transaction, run: JobRun): void {
		this.change(tx, { kind: "update", run, fields: { phase: "running" } });
	}

	/** A state change of a run with restarts counted resets them in its commit (progress, D6). */
	progressed(tx: Transaction, run: JobRun): void {
		if (run.restarts !== 0) this.change(tx, { kind: "update", run, fields: { restarts: 0 } });
	}

	/**
	 * A run's invocation settled: its outcome is recorded (phase `finishing`) in a transaction of the object behind the
	 * state changes admitted before, so `outcome.state` has them; then it is finished on the live attempt.
	 */
	settled(run: JobRun, ended: Settled): void {
		void this.#recordOutcome(run, ended);
	}

	/**
	 * A running run whose attempt was sealed: its signal fires with `error`, its invocation is fenced (later state
	 * changes refused, the open one discarded, its settling ignored). In memory it ends `failed { aborted, reason:
	 * "restart" }`, finished on the next live attempt; persisted it is stopped (R3), written back by the close writer and
	 * resumed by the next live attempt as after a clean close.
	 */
	cut(run: JobRun, error: ChordError): void {
		// Only an invoked run is cut: its current invocation is the one the seal stops.
		const invocation = run.invocation!;
		invocation.settle();
		this.#owner.documents.fence(invocation.token);
		invocation.abort.abort(error);
		if (this.#persisted !== undefined) {
			run.phase = "stopped";
			// Resumed per the job's `resume` (an `abandon` job's run ends `failed { aborted, restart }`).
			run.resuming = true;
			this.#stopped.add(run);
			if (this.#ended === undefined) this.#need(run);
			return;
		}
		if (this.#ended === undefined) void this.#recordOutcome(run, RESTART);
	}

	/**
	 * Records `change` (a run's finish failure, its block, its drop) in a transaction of the object, if `run` is still
	 * one of its runs there. The object's end ends it.
	 */
	async record(run: JobRun, change: RecordChange): Promise<void> {
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					if (this.#runs.get(run.id) === run) this.change(tx, change);
				},
				documents.own,
				context,
			);
		} catch {
			// The object ended: its runs went with it.
		}
	}

	/**
	 * The close writer (slice 6b §4.2, Durable's `writeAtClose`): one commit past the seal writing the runs a clean stop
	 * cut off `stopped` and every held state change, straight to the store (the object's transactions are refused by
	 * now). Its failure is the store's; the records stay as they were (a crash counts them).
	 */
	async writeAtClose(context: Context): Promise<void> {
		const persisted = this.#persisted;
		if (persisted === undefined) return;
		const writes: StagedWrite[] = [];
		const adopts: (() => void)[] = [];
		for (const run of this.#stopped) {
			adopts.push(persisted.stage(run.id, storedRun(run, this.definition.fingerprint), writes));
		}
		this.#stopped.clear();
		for (const id of this.#states?.heldIds ?? []) {
			const adopt = this.#states!.stageHeld(id, writes);
			if (adopt !== undefined) adopts.push(adopt);
		}
		if (writes.length === 0) return;
		const fence = { admit: () => true, adopt: () => runAll(adopts) };
		try {
			await this.#owner.store!.store.commit(writes, fence, withoutAbortSignal(context));
		} catch {
			// The store failed or refused it (reported as the store's): a crash loses as much.
		}
	}

	/** Stores every held state change whose deadline passed (`now`), in one transaction of the object (D8). */
	async flushHeld(now: number): Promise<void> {
		const states = this.#states;
		if (states === undefined || states.heldIds.length === 0) return;
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					const staging = this.staging(tx);
					for (const id of states.heldIds) {
						if (states.deadline(id) > now) continue;
						const adopt = states.stageHeld(id, this.#store(tx));
						if (adopt !== undefined) staging.adopts.push(adopt);
					}
				},
				documents.own,
				context,
			);
		} catch {
			// The object is ending: its close writer stores what is held.
		}
	}

	/** The earliest deadline of a held state change (`Infinity`: none). */
	nextDeadline(): number {
		const states = this.#states;
		if (states === undefined) return Number.POSITIVE_INFINITY;
		return Math.min(Number.POSITIVE_INFINITY, ...states.heldIds.map((id) => states.deadline(id)));
	}

	/** The value of run `id`'s state document, `undefined` without one or once retired. */
	stateOf(id: string): JsonObject | undefined {
		return this.#states?.value(id);
	}

	/** The run state documents, for `ctx.state.change`; `undefined` without a state definition. */
	get states(): RunStates | undefined {
		return this.#states;
	}

	/** Whether the job persists its runs. */
	get persisted(): boolean {
		return this.#persisted !== undefined;
	}

	/**
	 * The object ends: running runs' signals fire, every waiter rejects with `error`; blocked in-memory runs are
	 * dropped (reported), persisted ones keep their records; nothing finishes. The records stay readable until `drop`.
	 */
	end(error: ChordError): void {
		if (this.#ended !== undefined) return;
		this.#ended = error;
		this.#job = undefined;
		this.#waiting.clear();
		for (const run of this.#runs.values()) {
			if (run.phase === "blocked" && this.#persisted === undefined) this.report({ kind: "job_dropped", id: run.id });
			const { invocation } = run;
			invocation?.abort.abort(error);
			run.reject(error);
			if (invocation?.state !== "running") invocation?.ended();
		}
		if (this.#active > 0) this.#owner.countRuns(-this.#active);
	}

	/** Its object's documents are dropped: the runs, their state documents and `running`'s watches go. */
	drop(): void {
		this.#runs.clear();
		this.#keys.clear();
		this.#states?.drop();
		this.#persisted?.drop();
		this.running.end();
	}

	/** Reports a run's failure, drop or interruption to the host. */
	report(
		error:
			| { readonly kind: "job_failed" | "job_finish_failed"; readonly id: string; readonly error: unknown }
			| { readonly kind: "job_dropped"; readonly id: string }
			| { readonly kind: "job_interrupted"; readonly id: string; readonly restarts: number },
	): void {
		this.#owner.host.report({ ...error, object: this.#owner.label, job: this.definition.name });
	}

	/** The store writes of `tx` (Chord's own documents of a persisted job). */
	#store(tx: Transaction): StagedWrite[] {
		return tx.stageStore(this.#owner.store!.store);
	}

	/**
	 * The run a loaded record stands for and the change its activation writes (D6): a record of another version or
	 * fingerprint blocked as stored (its state document only found, never decoded: slice 7 maps it); otherwise its state
	 * document read and decoded (migrated), pinned while it is unsettled, a crash counted, at the limit its outcome,
	 * marked resuming unless blocked or finishing.
	 */
	async #restored(loaded: LoadedRecord, context: Context): Promise<Restored> {
		const { id, record } = loaded;
		const { definition } = this;
		const run = new JobRun(id, record.version, record.key, record.args, record.phase, record.trace);
		run.restarts = record.restarts;
		run.finishFailures = record.finishFailures;
		run.abortMarked = record.abort === true;
		const states = this.#states;
		if (record.version !== definition.version || record.fingerprint !== definition.fingerprint) {
			run.phase = "blocked";
			run.blocked = "version";
			// What is stored of its state (also when this version declares none), so an abort drops it with the record.
			await this.#persisted!.findBlockedState(id, context);
			return { run, change: undefined };
		}
		const document = await states?.persistence.read(id, context);
		if (document !== undefined) {
			const { value, stored } = states!.persistence.decode(document, states!.definition.current, context);
			states!.create(id, value, stored);
		}
		if (record.outcome !== undefined) run.outcome = outcomeOf(record.outcome, id, record.args, this.stateOf(id));
		run.blocked = record.blocked;
		switch (record.phase) {
			case "running": {
				const restarts = record.restarts + 1;
				run.resuming = true;
				if (restarts < RESTART_LIMIT) {
					return { run, change: { kind: "update", run, fields: { phase: "pending", restarts } } };
				}
				run.restarts = restarts;
				const outcome = this.#outcome(run, { kind: "failed", error: { kind: "restart_limit", restarts } });
				return { run, change: { kind: "outcome", run, outcome } };
			}
			case "stopped":
				run.resuming = true;
				return { run, change: { kind: "update", run, fields: { phase: "pending" } } };
			case "pending":
				run.resuming = true;
				return { run, change: undefined };
			default:
				return { run, change: undefined };
		}
	}

	/** Records the outcome of `run` (with what its state holds, D8), then has it finished on the live attempt. */
	async #recordOutcome(run: JobRun, ended: Settled): Promise<void> {
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					const outcome = this.#outcome(run, ended);
					this.change(tx, { kind: "outcome", run, outcome });
					// What its state holds is stored before the outcome is recorded (D8).
					const adopt =
						this.#persisted === undefined ? undefined : this.#states?.stageHeld(run.id, this.#store(tx));
					if (adopt !== undefined) this.staging(tx).adopts.push(adopt);
				},
				documents.own,
				context,
			);
		} catch {
			// The object ended: nothing finishes.
			return;
		} finally {
			// A run ending without an invocation (marked aborted, abandoned, cut off in memory) has none to wait for.
			run.invocation?.ended();
		}
		this.#need(run);
	}

	/** `run`'s outcome for `ended`, with its args and its state as it is now. */
	#outcome(run: JobRun, ended: Settled): AnyOutcome {
		return { id: run.id, args: run.args, state: this.stateOf(run.id), ...ended };
	}

	/** `run` needs a live attempt (to be invoked or finished): now, or once one attaches. */
	#need(run: JobRun): void {
		if (this.#ended !== undefined || this.#runs.get(run.id) !== run) return;
		const job = this.#job;
		if (job === undefined) this.#waiting.add(run);
		else this.#dispatch(run, job);
	}

	/**
	 * Invokes or finishes `run` on `job`, as its record stands: a finishing run is finished; a run not invoked yet is
	 * invoked, unless it is marked aborted (it ends `aborted` without `run`) or resumes abandoned (`failed { aborted,
	 * reason: "restart" }`).
	 */
	#dispatch(run: JobRun, job: Job): void {
		if (this.#runs.get(run.id) !== run) return;
		if (run.phase === "finishing") {
			job.finish(run);
			return;
		}
		if (run.phase === "blocked" || run.invoked) return;
		if (run.abortMarked) {
			void this.#recordOutcome(run, ABORTED);
			return;
		}
		if (run.resuming && this.definition.persist?.resume === "abandon") {
			void this.#recordOutcome(run, RESTART);
			return;
		}
		run.resuming = false;
		job.invoke(run);
	}

	/**
	 * Adopts one record change, inside the commit step: the maps, the active count, `running`. A new run is counted for
	 * its object here, before the commit's publication (a link closing while it sends may release the object's last
	 * reference) and before any run of the same commit settles in `#committed`.
	 */
	#adopt(change: Adopted): void {
		const { run } = change;
		switch (change.kind) {
			case "create":
			case "restore":
				this.#runs.set(run.id, run);
				if (run.key !== undefined) this.#keys.set(run.key, run);
				if (run.phase !== "blocked") {
					this.#active++;
					this.#owner.countRuns(1);
				}
				run.entry = run.entryFor(this.stateOf(run.id));
				this.running.add(run.entry);
				return;
			case "update":
				Object.assign(run, change.fields);
				this.#replaceEntry(run);
				return;
			case "outcome":
				run.outcome = change.outcome;
				run.phase = "finishing";
				this.#replaceEntry(run);
				return;
			case "block":
				run.phase = "blocked";
				run.blocked = change.reason;
				this.#active--;
				this.#replaceEntry(run);
				return;
			case "delete":
			case "drop":
				this.#runs.delete(run.id);
				// The finishing run's key may name its successor already, started in the same commit.
				if (run.key !== undefined && this.#keys.get(run.key) === run) this.#keys.delete(run.key);
				if (change.kind === "delete") this.#active--;
				this.running.remove(run.entry!);
				run.entry = undefined;
				return;
		}
	}

	/** The actions after a record change committed. */
	#committed(change: Adopted): void {
		const { run } = change;
		switch (change.kind) {
			case "create":
				// After the commit, outside the batch, once the transaction settled; on the live attempt, or the next.
				queueMicrotask(() => this.#need(run));
				return;
			case "restore":
			case "update":
			case "outcome":
				return;
			case "delete":
				this.#owner.countRuns(-1);
				run.resolve(run.outcome!);
				return;
			case "block":
				this.#owner.countRuns(-1);
				return;
			case "drop":
				this.report({ kind: "job_dropped", id: run.id });
				run.reject(new ChordError({ code: "aborted", message: `${this.name}: run ${run.id} dropped` }));
				return;
		}
	}

	/** A run's state document changed by `ops`, inside the commit step: its entry is replaced. */
	#stateChanged(id: string, ops: readonly Op[]): void {
		const run = this.#runs.get(id);
		// Its record may not be adopted yet (a start creates both in one commit; its entry takes the state then).
		if (run?.entry === undefined) return;
		const before = run.entry;
		run.entry = run.entryFor(this.stateOf(id));
		this.running.stateChanged(before, run.entry, ops);
	}

	/** A run's record changed, inside the commit step: its entry is replaced. */
	#replaceEntry(run: JobRun): void {
		const before = run.entry!;
		run.entry = run.entryFor(this.stateOf(run.id));
		this.running.replace(before, run.entry);
	}

	#discarded(): ChordError {
		return new ChordError({
			code: "released",
			reason: "discarded",
			message: `${this.name}: the start's transaction was discarded`,
		});
	}
}

/** Runs every adoption of `adopts`. */
function runAll(adopts: readonly (() => void)[]): void {
	for (const adopt of adopts) adopt();
}

/** The record fields a change writes, its phase transitions included. */
function recordFields(change: Exclude<RecordChange, { kind: "delete" | "drop" }>): StoredFields {
	switch (change.kind) {
		case "create":
			return {};
		case "update":
			return change.fields;
		case "outcome":
			return { phase: "finishing", outcome: change.outcome };
		case "block":
			return { phase: "blocked", blocked: change.reason };
	}
}
