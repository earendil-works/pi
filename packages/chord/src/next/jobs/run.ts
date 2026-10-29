// One run of a job (§15, slice 6b §4.1): its record (id, version, key, args, phase, restarts, finish failures, abort
// mark, outcome), its current invocation (the fence of its seal token, its abort signal, the end an abort joins: one
// per invocation, as a persisted run is invoked again after a seal, R3), its `running` entry and the `Run` handle its
// callers wait on.

import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { ChordError } from "../data/index.ts";
import { SealToken } from "../documents/internal.ts";
import type { Outcome } from "./definition.ts";

/** A started run as its caller holds it: its id and a wait for its outcome. */
export interface Run<O> {
	readonly id: string;
	/**
	 * Resolves with the outcome once `finish` committed (also without a `finish`); a blocked run keeps waiting, a dropped
	 * one rejects `aborted`, the object's end rejects with its error; `context` ends only this wait, which then keeps
	 * nothing of it. A rejection's error keeps its stack's receivers (the transaction that ended the run) until its
	 * `stack` is read (V8).
	 */
	outcome(context: Context): Promise<O>;
}

/** A run's outcome, as Chord keeps it whatever the job's types. */
export type AnyOutcome = Outcome<JsonValue, unknown, JsonValue | undefined>;

/**
 * Where a run's record stands. A persisted run is `pending` from its start's commit until its reservation commit
 * (`running`, then its `run` starts), `stopped` once a clean stop cut it off; an in-memory run is `running` from its
 * start's commit. `finishing` once its outcome is recorded, `blocked` after five failed finishes or for another
 * version.
 */
export type Phase = "pending" | "running" | "stopped" | "finishing" | "blocked";

/** Why a run is blocked: its `finish` failed five times in a row, or it was stored by another job version (slice 7). */
export type BlockedReason = "finish_failed" | "version";

/** How a run settled for its waiters. */
type Answer =
	| { readonly kind: "done"; readonly outcome: AnyOutcome }
	| { readonly kind: "failed"; readonly error: ChordError };

/** One wait for a run's outcome, removed when its context aborts. */
type Waiter = { readonly settle: (settled: Answer) => void };

/** One run: changed only by its job, inside its transactions' commit steps (records) and after them (actions). */
export class JobRun {
	readonly id: string;
	readonly version: number;
	readonly key: string | undefined;
	readonly args: JsonValue;
	readonly handle: Run<AnyOutcome>;
	/** Its current invocation, from its reservation (or its start in memory) on; a later one replaces it. */
	invocation: Invocation | undefined;
	phase: Phase;
	/** A persisted run's crashes in a row while running (D6); reset by a state change. */
	restarts = 0;
	/** Failed finishes in a row (stored for a persisted run, so they count across a crash). */
	finishFailures = 0;
	/** Set by `abort(id)` (stored for a persisted run, D7): a run not invoked yet ends `aborted` without `run`. */
	abortMarked = false;
	/** A persisted run cut off by a crash or a clean stop, to be resumed per its job's `resume` (no new start). */
	resuming = false;
	blocked: BlockedReason | undefined;
	/** The start's trace carrier, when the adapter propagates (stored, slice 9 uses it). */
	readonly trace: { readonly [key: string]: string } | undefined;
	/** What it ended with, once recorded (finishing and blocked). */
	outcome: AnyOutcome | undefined;
	/** Its entry in `running`, while its record exists; replaced when its record or state document changes. */
	entry: JsonValue | undefined;
	/** Its waiters: apart from the run, so a handle kept by a caller keeps only how the run settled. */
	readonly #waiters = new Waiters();

	constructor(
		id: string,
		version: number,
		key: string | undefined,
		args: JsonValue,
		phase: Phase,
		trace?: { readonly [key: string]: string },
	) {
		this.id = id;
		this.version = version;
		this.key = key;
		this.args = args;
		this.phase = phase;
		this.trace = trace;
		const waiters = this.#waiters;
		this.handle = { id, outcome: (context) => waiters.wait(context) };
	}

	/**
	 * Its `running` entry for its current record and `state` (the job's state document, `undefined` without one): a
	 * pending or stopped run shows as `running` (it runs, or will run again).
	 */
	entryFor(state: JsonValue | undefined): JsonValue {
		const { id, version, key, args, phase } = this;
		if (phase === "blocked") return { id, version, phase, reason: this.blocked! };
		return {
			id,
			version,
			...(key === undefined ? {} : { key }),
			args,
			...(state === undefined ? {} : { state }),
			phase: phase === "finishing" ? "finishing" : "running",
		};
	}

	/** A new invocation, the current one from now on (a run marked aborted is never invoked: it ends without one). */
	begin(): Invocation {
		const invocation = new Invocation();
		this.invocation = invocation;
		return invocation;
	}

	/** Whether its current invocation runs (or is reserved): it is not invoked again meanwhile. */
	get invoked(): boolean {
		return this.invocation?.state === "running";
	}

	/**
	 * Resolves once its current invocation ended, at once when none runs (`abort` joins it; one a seal cut off is
	 * fenced and is not waited for); `context` ends only the wait.
	 */
	over(context: Context): Promise<void> {
		const invocation = this.invocation;
		return invocation?.state === "running" ? invocation.over(context) : Promise.resolve();
	}

	/** Its waiters get the outcome. */
	resolve(outcome: AnyOutcome): void {
		this.#waiters.settle({ kind: "done", outcome });
	}

	/** Its waiters get `error`. */
	reject(error: ChordError): void {
		this.#waiters.settle({ kind: "failed", error });
	}
}

/**
 * One invocation of a run's `run`: its fence (`ctx.state.change` admitted while it runs, under its own seal token,
 * which its attempt's seal fences), its abort signal and the waits for its end. Captured by its ctx and its settling,
 * so a replaced invocation never acts for its successor.
 */
export class Invocation {
	readonly token = new SealToken();
	/** `run`'s abort signal: `abort(id)`, the attempt's seal, the object's end and `host.close` fire it. */
	readonly abort = new AbortController();
	/** `running` from its reservation until `run` settled or a seal cut it off. */
	state: "running" | "settled" = "running";
	readonly #joins = new Joins();

	/** The fence closes: a change made later is refused. */
	settle(): void {
		this.state = "settled";
	}

	/** Nothing of it runs here any more (its `run` settled, or the object ended): every join resolves. */
	ended(): void {
		this.#joins.end();
	}

	/** Resolves once it ended; `context` ends only the wait. */
	over(context: Context): Promise<void> {
		return this.#joins.wait(context);
	}
}

/** A run's waits for its outcome: each removed when its context aborts; late ones answered at once. */
class Waiters {
	/** How the run settled, once it did. */
	#settled: Answer | undefined;
	readonly #waiting = new Set<Waiter>();

	/** The run settled (once): every wait gets it. */
	settle(settled: Answer): void {
		if (this.#settled !== undefined) return;
		this.#settled = settled;
		for (const waiter of this.#waiting) waiter.settle(settled);
		this.#waiting.clear();
	}

	/** A wait for the outcome: at once once settled; otherwise until it settles or `context` aborts. */
	wait(context: Context): Promise<AnyOutcome> {
		const settled = this.#settled;
		if (settled !== undefined) return answer(settled);
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const { promise, resolve, reject } = Promise.withResolvers<AnyOutcome>();
		const abort = (): void => {
			this.#waiting.delete(waiter);
			reject(signal?.reason);
		};
		const waiter: Waiter = {
			settle: (each) => {
				signal?.removeEventListener("abort", abort);
				if (each.kind === "done") resolve(each.outcome);
				else reject(each.error);
			},
		};
		this.#waiting.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		return promise;
	}
}

/** A settled run's answer to a wait. */
function answer(settled: Answer): Promise<AnyOutcome> {
	return settled.kind === "done" ? Promise.resolve(settled.outcome) : Promise.reject(settled.error);
}

/** The waits for a run's invocation to be over: each removed when its context aborts, so a cancelled one keeps nothing. */
class Joins {
	#over = false;
	readonly #waiting = new Set<() => void>();

	/** The invocation is over (once): every wait resolves. */
	end(): void {
		if (this.#over) return;
		this.#over = true;
		for (const resolve of this.#waiting) resolve();
		this.#waiting.clear();
	}

	/** A wait: at once when over; otherwise until it is or `context` aborts (rejecting with its reason). */
	wait(context: Context): Promise<void> {
		if (this.#over) return Promise.resolve();
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const abort = (): void => {
			this.#waiting.delete(done);
			reject(signal?.reason);
		};
		const done = (): void => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		this.#waiting.add(done);
		signal?.addEventListener("abort", abort, { once: true });
		return promise;
	}
}
