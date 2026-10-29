// Routines (§14): the standing behaviour an object or a facet declares, `self.on(source, fn)` and `self.onLive(fn)`.
// They start once their owner went live and stop when it ends (their ctx aborted, the drain waits for running calls);
// each call gets its own ctx; a call that throws is reported and called again after a backoff.

import type { Context } from "../../context/index.ts";
import { type Op, PendingOps } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	NativeWatch,
	type NativeWatchable,
	type NativeWatchCall,
	type Watchable,
	type WatchCall,
	type WatchEnd,
} from "../../watch.ts";
import type { Principal } from "../data/index.ts";
import { NativeSource, Source } from "../state/internal.ts";
import { nextDelay } from "./backoff.ts";
import { CallContext, type Caller, type Ctx } from "./ctx.ts";
import type { AnyHost, Position } from "./host.ts";
import { resolveWatchable } from "./reference.ts";
import { sleep } from "./sleep.ts";

/**
 * Where routines run: their owner's label (for reports), its host, whom their calls act for, and the context of their
 * calls, aborted when the owner ends. `admit` adds a running call to the owner's drain.
 */
export type RoutineOwner = {
	readonly label: string;
	readonly host: AnyHost;
	readonly caller: Caller;
	readonly context: Context;
	/**
	 * Adds a running call to the drain; `cleanup` (its bookkeeping) runs once, when it settles or when the attempt ends
	 * with it still running.
	 */
	admit(running: Promise<unknown>, cleanup: () => void): void;
};

/**
 * A routine's handler of a JSON source: the value call (the value, the ops since the previous call, whether the
 * source's document was retired since then) and the call's ctx. Failures are not calls of a handler (design §11): the
 * routine waits for the next value.
 */
export type OnHandler<T, C extends Ctx = Ctx> = (call: WatchValueCall<T>, ctx: C) => void | Promise<void>;

/** A JSON watch's value call: what an `on` handler gets. */
export type WatchValueCall<T> = Extract<WatchCall<T>, { readonly kind: "value" }>;

/** A native watch's value call. */
export type NativeWatchValueCall<T> = Extract<NativeWatchCall<T>, { readonly kind: "value" }>;

/** A routine's handler of a native source: the value call (the value) and the call's ctx. */
export type OnNativeHandler<T, C extends Ctx = Ctx> = (call: NativeWatchValueCall<T>, ctx: C) => void | Promise<void>;

/** An `onLive` routine: called once its owner is live. */
export type OnLiveHandler<C extends Ctx = Ctx> = (ctx: C) => void | Promise<void>;

/** What the declarations of an owner (`on`, `onLive`) take; part of the factory's `self` and the facet's. */
export interface RoutineDeclarations<P extends Principal = Principal> {
	/**
	 * A routine over `source`: `fn` gets its current value first (ops `[["r", value]]`), then one call per change,
	 * never overlapping: changes during a call fold into one next call (the newest value, the ops since the previous
	 * call, `retired` when any of them was a retirement). After a call that threw, it is called again with the whole
	 * newest value (`retired` again if the call that threw had it) after a backoff (1 s doubling to 60 s), or at once on
	 * a change during the backoff. Ends with its source. A JSON watchable is one whose watch is Chord's shared `Watch`
	 * (every Chord and Durable source).
	 */
	on<T>(source: Watchable<T>, fn: OnHandler<T, Ctx<P>>): void;
	/**
	 * A routine over a native source (a registry value, `ref.state`): one whose watch is Chord's shared `NativeWatch`.
	 * As above without ops: after a busy call, one call with the newest value.
	 */
	on<T>(source: NativeWatchable<T>, fn: OnNativeHandler<T, Ctx<P>>): void;
	/**
	 * A routine called once its owner is live. Returning ends it; a throw is reported and restarts it after a backoff
	 * (1 s doubling to 60 s, reset after a run of a minute); the owner's end aborts its ctx.
	 */
	onLive(fn: OnLiveHandler<Ctx<P>>): void;
}

/** A declared routine: its kind and position in reports (`{ kind: "on", position: 2 }`), its source and its handler. */
type Declaration =
	| {
			readonly kind: "on";
			readonly at: Position;
			readonly source: Watchable<unknown> | NativeWatchable<unknown>;
			readonly fn: (...args: never[]) => void | Promise<void>;
	  }
	| { readonly kind: "onLive"; readonly at: Position; readonly fn: OnLiveHandler };

/** How one routine call ended. */
type Called = { readonly kind: "done" } | { readonly kind: "failed"; readonly error: unknown };

const DONE: Called = { kind: "done" };

/** What `#failing` says of a source failed now. */
const FAILING = { kind: "failed" } as const;

/** One run of an `onLive` that lasted this long resets its backoff. */
const LONG_RUN = 60_000;

/** An owner's routines: declared while its factory (or setup) runs, started once when it went live. */
export class Routines {
	readonly #declared: Declaration[] = [];
	#ons = 0;
	#lives = 0;

	/** Declares `on(source, fn)`; whether the source is JSON or native is decided by its watch (`OnRoutine`). */
	on(source: Watchable<unknown> | NativeWatchable<unknown>, fn: (...args: never[]) => void | Promise<void>): void {
		this.#declared.push({ kind: "on", at: { kind: "on", position: ++this.#ons }, source, fn });
	}

	/** Declares `onLive(fn)`. */
	onLive(fn: OnLiveHandler): void {
		this.#declared.push({ kind: "onLive", at: { kind: "onLive", position: ++this.#lives }, fn });
	}

	/**
	 * Starts every routine for `owner`, which went live; they stop when its context is aborted. A routine whose
	 * synchronous start ends the owner (an `onLive` releasing its last reference) starts none of the later ones.
	 */
	start(owner: RoutineOwner): void {
		for (const declaration of this.#declared) {
			if (owner.context.abortSignal?.aborted) return;
			if (declaration.kind === "on") void new OnRoutine(owner, declaration).start();
			else void live(owner, declaration);
		}
	}
}

/**
 * Runs `onLive`'s handler until it returns or its owner ends; a throw is reported and the handler restarts after the
 * backoff.
 */
async function live(owner: RoutineOwner, { at, fn }: Extract<Declaration, { kind: "onLive" }>): Promise<void> {
	let delay: number | undefined;
	while (!owner.context.abortSignal?.aborted) {
		const started = Date.now();
		const called = await call(owner, fn);
		if (called.kind === "done" || owner.context.abortSignal?.aborted) return;
		failed(owner, at, called.error);
		delay = nextDelay(Date.now() - started >= LONG_RUN ? undefined : delay);
		try {
			await sleep(delay, owner.context);
		} catch {
			return;
		}
	}
}

/**
 * Runs one routine call under its own ctx (its `ctx.get` references released when it settles), admitted to the owner's
 * drain before the handler runs: a handler may end its own owner before its first await. Resolves with how it ended;
 * never rejects.
 */
function call(owner: RoutineOwner, invoke: (ctx: Ctx) => void | Promise<void>): Promise<Called> {
	const ctx = new CallContext(owner.context, owner.caller, owner.host);
	const settled = Promise.withResolvers<Called>();
	owner.admit(settled.promise, () => ctx.settle());
	const finish = (called: Called): void => {
		ctx.settle();
		settled.resolve(called);
	};
	// Plugin code: a synchronous throw becomes the rejection.
	(async () => invoke(ctx))().then(
		() => finish(DONE),
		(error: unknown) => finish({ kind: "failed", error }),
	);
	return settled.promise;
}

/** Reports a failed routine call or source. */
function failed(owner: RoutineOwner, routine: Position, error: unknown): void {
	owner.host.report({ kind: "routine_failed", object: owner.label, routine, error });
}

/**
 * Where an `on` routine stands. `starting`: taking its watch; `idle`: waiting for a change; `calling`: a call runs
 * (changes meanwhile wait, folded, for the next); `settling`: a call succeeded while changes arrived, and the next one
 * waits for one macrotask, so every value its watch still buffers (a native watch replays them one per microtask) is
 * taken first; `backoff`: the last call threw and its timer calls again, unless a change during the backoff calls
 * first; `ended`: its watch ended (the owner ended, or the source ended or failed).
 */
type OnState =
	| { readonly kind: "starting" | "idle" | "calling" | "ended" }
	| { readonly kind: "settling" | "backoff"; readonly timer: ReturnType<typeof setTimeout> };

/**
 * What the next call's ops are relative to: `none` before the first call and after a throw (the handler may not have
 * applied what it got: the next call gets the whole value), `last` after a call that succeeded.
 */
type Basis = "none" | "last";

/**
 * One `on` routine. Its watch's listener never throws (a throwing listener would end the watch) and never waits: it
 * keeps the newest frame, folding JSON ops, and the routine makes one call at a time from it, the first call and the
 * retries after a throw through the same pending frame.
 */
class OnRoutine {
	readonly #owner: RoutineOwner;
	readonly #declaration: Extract<Declaration, { kind: "on" }>;
	#state: OnState = { kind: "starting" };
	/** A native source's watch yields values without ops; decided by its watch's class. */
	#native = false;
	/** The newest value no call got yet. */
	#pending: { readonly value: unknown } | undefined;
	/** The ops of the frames since the last call (JSON sources), folded. */
	readonly #ops = new PendingOps();
	/** One of the frames since the last call was a retirement (JSON sources). */
	#retired = false;
	#basis: Basis = "none";
	/** The value of the last call: a retry after a throw calls with it. */
	#last: unknown;
	/** The last call reported a retirement: a retry after a throw reports it again. */
	#lastRetired = false;
	#delay: number | undefined;
	/** The source failed after its last value: no call until its next value (a retry waits too). */
	#failed = false;

	constructor(owner: RoutineOwner, declaration: Extract<Declaration, { kind: "on" }>) {
		this.#owner = owner;
		this.#declaration = declaration;
	}

	/**
	 * Takes the watch and calls with its value. On a failed Chord source it waits for its first good value instead (a
	 * source that never had one is followed until it has). A source that cannot be watched otherwise is reported; an
	 * owner or source that ended meanwhile ends the routine. Never rejects.
	 */
	async start(): Promise<void> {
		const { source, at } = this.#declaration;
		let failing = this.#failing();
		while (failing?.kind === "no_value") {
			if (!(await this.#firstValue(failing.source))) {
				this.#state = { kind: "ended" };
				return;
			}
			// Asked again: a failure may have followed the first value before this resumed (one receive turn).
			failing = this.#failing();
		}
		let watch: Awaited<ReturnType<typeof source.watch>>;
		try {
			watch = await source.watch(this.#owner.context);
		} catch (error) {
			this.#state = { kind: "ended" };
			if (!this.#aborted()) failed(this.#owner, at, error);
			return;
		}
		this.#native = watch instanceof NativeWatch;
		void watch.closed.then((end) => this.#end(end));
		try {
			// Both listeners return at once.
			watch.start((call: WatchCall<unknown> | NativeWatchCall<unknown>) => {
				if (call.kind === "value") this.#frame(call);
				else this.#failure();
				return Promise.resolve();
			});
		} catch {
			// The watch ended while it was taken (the owner or the source ended): `closed` says how.
			return;
		}
		// A watch opened on a failed source holds its last good value, a stale one: its first call is the failure.
		if (failing?.kind === "failed") {
			this.#state = { kind: "idle" };
			return;
		}
		this.#pending = { value: watch.value };
		this.#next();
	}

	/**
	 * Whether the source is a Chord source failed now (`failed`), or a JSON one with no value yet (`no_value`, with the
	 * source to follow); `undefined` otherwise (Durable's views tell their failures through their watches).
	 */
	#failing(): { readonly kind: "failed" } | { readonly kind: "no_value"; readonly source: Source } | undefined {
		const declared = this.#declaration.source;
		// A native source opens its watch at its last good value while failed (a registry whose `compose` threw): its
		// first call is the failure, not that stale value.
		if (declared instanceof NativeSource) return declared.start().kind === "failed" ? FAILING : undefined;
		let source: unknown;
		try {
			source = resolveWatchable(this.#declaration.source);
		} catch {
			// Not bound or ended: the watch says so.
			return undefined;
		}
		if (!(source instanceof Source)) return undefined;
		let start: ReturnType<Source["start"]>;
		try {
			start = source.start();
		} catch {
			return undefined;
		}
		if (start.kind === "value") return undefined;
		return start.last === undefined ? { kind: "no_value", source } : { kind: "failed" };
	}

	/**
	 * Follows `source`, failed with no value, until its first good value (`true`), or until it or the owner ends
	 * (`false`): a subscriber of its own, since a watch has nothing to start at.
	 */
	#firstValue(source: Source): Promise<boolean> {
		const signal = this.#owner.context.abortSignal;
		return new Promise((resolve) => {
			const done = (got: boolean): void => {
				source.unsubscribe(subscriber);
				signal?.removeEventListener("abort", aborted);
				resolve(got);
			};
			const subscriber = {
				advance: (call: WatchCall<JsonValue>) => {
					if (call.kind === "value") done(true);
				},
				end: () => done(false),
				endAfterDelivery: () => done(false),
			};
			const aborted = (): void => done(false);
			signal?.addEventListener("abort", aborted, { once: true });
			if (signal?.aborted) aborted();
			else source.subscribe(subscriber);
		});
	}

	/**
	 * The source failed: what was pending goes (a value a failure followed is stale), a pending retry or settle is
	 * dropped, and the next call waits for the next value, as a whole value; a running call runs on.
	 */
	#failure(): void {
		const state = this.#state;
		if (state.kind === "ended") return;
		this.#failed = true;
		this.#pending = undefined;
		this.#ops.take();
		this.#basis = "none";
		if (state.kind === "backoff" || state.kind === "settling") {
			clearTimeout(state.timer);
			this.#state = { kind: "idle" };
		}
	}

	/**
	 * A frame of the watch: kept as the newest; it is called at once when nothing runs or waits, during a backoff too
	 * (the backoff ends); while a call runs or settles it waits for the next call.
	 */
	#frame(call: WatchValueCall<unknown> | NativeWatchValueCall<unknown>): void {
		const state = this.#state;
		if (state.kind === "ended") return;
		this.#failed = false;
		this.#pending = { value: call.value };
		if (!this.#native) {
			// A JSON watch's call, as its class decided.
			const { ops, retired } = call as WatchValueCall<unknown>;
			this.#ops.push(ops);
			if (retired) this.#retired = true;
		}
		if (state.kind === "backoff") clearTimeout(state.timer);
		if (state.kind === "backoff" || state.kind === "idle") this.#next();
	}

	/** Makes the next call from the pending frame, if there is one and the owner still runs; otherwise idles. */
	#next(): void {
		const pending = this.#pending;
		if (pending === undefined || this.#aborted()) {
			this.#state = { kind: "idle" };
			return;
		}
		this.#pending = undefined;
		const { value } = pending;
		this.#state = { kind: "calling" };
		this.#last = value;
		void call(this.#owner, this.#invocation(value)).then((called) => this.#called(called));
	}

	/**
	 * The handler's call with `value`: a native one with the value alone, a JSON one with the folded ops or the whole
	 * value, and whether a retirement came since the last call.
	 */
	#invocation(value: unknown): (ctx: Ctx) => void | Promise<void> {
		const { fn } = this.#declaration;
		// The overloads typed `fn` for its source's kind, which the watch decided.
		if (this.#native) return (ctx) => (fn as OnNativeHandler<unknown>)({ kind: "value", value }, ctx);
		const taken = this.#ops.take();
		// A JSON source's values are JSON.
		const ops: readonly Op[] =
			this.#basis === "none" || taken.kind === "replace" ? [["r", value as JsonValue]] : taken.ops;
		const retired = this.#retired;
		this.#retired = false;
		this.#lastRetired = retired;
		return (ctx) => (fn as OnHandler<unknown>)({ kind: "value", value, ops, retired }, ctx);
	}

	/**
	 * A call settled. After a success the next frame's ops build on it, and changes that arrived during the call are
	 * called after one macrotask (`settling`). After a throw (reported) the backoff always starts, also when changes
	 * arrived during the call (a handler that changes its own source and throws would feed itself otherwise); its timer
	 * calls with the newest value, or the last call's, as a whole value.
	 */
	#called(called: Called): void {
		if (this.#state.kind === "ended") return;
		if (called.kind === "done") {
			this.#basis = "last";
			this.#delay = undefined;
			if (this.#pending === undefined) this.#state = { kind: "idle" };
			else this.#state = { kind: "settling", timer: setTimeout(() => this.#next(), 0) };
			return;
		}
		if (this.#aborted()) return;
		failed(this.#owner, this.#declaration.at, called.error);
		this.#basis = "none";
		// The handler may not have applied the retirement either.
		if (this.#lastRetired) this.#retired = true;
		this.#delay = nextDelay(this.#delay);
		// The source failed meanwhile: the retry waits for its next value, never the stale last one.
		if (this.#failed) {
			this.#state = { kind: "idle" };
			return;
		}
		const timer = setTimeout(() => {
			this.#pending ??= { value: this.#last };
			this.#next();
		}, this.#delay);
		this.#state = { kind: "backoff", timer };
	}

	/** The watch ended: the owner ended (aborted), or the source ended (no report) or failed (reported once). */
	#end(end: WatchEnd): void {
		const state = this.#state;
		this.#state = { kind: "ended" };
		if (state.kind === "settling" || state.kind === "backoff") clearTimeout(state.timer);
		this.#pending = undefined;
		this.#ops.take();
		this.#retired = false;
		if (end.kind === "failed" && !this.#aborted()) failed(this.#owner, this.#declaration.at, end.error);
	}

	#aborted(): boolean {
		return this.#owner.context.abortSignal?.aborted === true;
	}
}
