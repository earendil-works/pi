// A follow over a changing source (ERNDL-1191; decision "A follow re-attaches over a changing source"): the attach of
// `self.follow(over, attach)`. To the followed source (`follow.ts`) it is one attachment for its attempt; behind it,
// it attaches to each value of `over` (a registry value, a writable), each attachment with its own observer, so that
// only the current one's calls and end count; it is a dependent of `over` and reconciles with its value after each
// batch that changed it. A new value is one replacement, with no failure in between; a failure of the value still
// given while live is a failure call (a failed member), retried after a backoff.

import { awaitWithContext, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { JsonValue } from "../json.ts";
import { RegistryValueSource } from "../registries/internal.ts";
import { type Dependent, FollowedSource, handedOut } from "../state/internal.ts";
import type { ChordMetrics } from "../telemetry.ts";
import type { WatchCall, WatchEnd } from "../watch.ts";
import { nextDelay } from "./backoff.ts";
import type { FollowAttach, FollowAttachment, FollowObserver } from "./follow.ts";

/**
 * What `self.follow(over, attach)` takes: attaches `observer` for `value`, a value of `over` (never `undefined`: then
 * nothing is followed), resolving with the attachment, `undefined` for an absent address.
 */
export type FollowOverAttach<S, T> = (
	value: S,
	observer: FollowObserver<unknown>,
	context: Context,
) => Promise<FollowAttachment<T> | undefined>;

/** Who a follow over a changing source belongs to: its attempt. */
export type FollowOverOwner = {
	readonly label: string;
	/** What its attachments run under once its attempt is live: the object's context under the attempt's signal. */
	readonly context: Context;
	/** Its host's instruments: its attachments are counted there (`chord.follow.attaches`). */
	readonly metrics: ChordMetrics;
	/** Whether its attempt is live: before, a failure of the value given is its activation's (R4). */
	live(): boolean;
	/** A failure while live (`follow_failed`), once per failure episode, or a runtime's detach that threw. */
	report(error: unknown): void;
	/** What the activation waits for (a value of `over`), named in its deadline's error; `undefined`: nothing. */
	waiting(what: string | undefined): void;
};

/**
 * Checks the source of `self.follow(over, attach)` (declaration policy: TypeScript cannot tell a reference's member
 * or a derive from a registry value or a writable).
 */
export function followedOver(source: unknown, label: string): FollowedSource<unknown> {
	if (source instanceof FollowedSource) return source;
	throw new Error(`${label}: self.follow(over, attach) follows registry values and writables`);
}

/** The attach of a source followed over `over`: `attach` for each of its values, for the attempt `owner` stands for. */
export function followOver(
	over: FollowedSource<unknown>,
	attach: FollowOverAttach<unknown, JsonValue>,
	owner: FollowOverOwner,
): FollowAttach<JsonValue> {
	return (observer, context) => new FollowOver(over, attach, owner, observer, context).first();
}

/**
 * One attachment of the runtime's observer: the value of `over` it is for, what its calls gave while it attached
 * (folded: only the newest state is kept), and the runtime's observation once it resolved (its calls held until then).
 */
type Attachment = {
	readonly for: unknown;
	held: Held;
	observation: FollowAttachment<JsonValue> | undefined;
};

/**
 * What an attachment's calls gave before it resolved, folded: nothing, a value, or a failure with the last value
 * before it (`undefined`: none came; JSON has no `undefined`).
 */
type Held =
	| { readonly kind: "none" }
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: { readonly value: JsonValue } | undefined };

const NOTHING_HELD: Held = { kind: "none" };

/** One followed source's attachments over the values of `over`, for one attempt. */
class FollowOver implements Dependent {
	readonly #over: FollowedSource<unknown>;
	readonly #attach: FollowOverAttach<unknown, JsonValue>;
	readonly #owner: FollowOverOwner;
	/** The followed source's observer, and the context of its activation, whose signal is its attempt's. */
	readonly #observer: FollowObserver<JsonValue>;
	readonly #activation: Context;
	/**
	 * The detach the followed source gets. Made here, not where the first attachment resolves: a closure there would
	 * keep that scope, and with it the first attachment and its value of `over`, for the attempt's life.
	 */
	readonly #release = (): void => this.#detach();
	/** The activation's wait for its first current attachment; `undefined` once it was given (or failed). */
	#first: PromiseWithResolvers<FollowAttachment<JsonValue>> | undefined;
	/** The attachment whose calls and end count; none while `over` has no value or its attachment failed. */
	#current: Attachment | undefined;
	/** Set when `over` changed in a batch, until its new value was read: calls of the current one are checked then. */
	#moving = false;
	/** Whether a reconciliation with `over`'s value is queued (once per change, outside the batch). */
	#reconciling = false;
	/**
	 * A value of `over` with no attachment that waits (`undefined`: none; a value of `over` never is): its attachment
	 * failed (the same value again waits for the retry) or its runtime ended it (only another value attaches). Let go of
	 * at the next other value `over` commits (`#checkIdle`), also when a later batch gives it back before the
	 * reconciliation.
	 */
	#idle: unknown;
	/** Whether `#checkIdle` is listed for the end of the current batch. */
	#checking = false;
	/** Observations let go of, to detach outside the batch, and before anything attaches again. */
	#leaving: FollowAttachment<JsonValue>[] = [];
	/** From a failure while live to the next attachment taken: the episode is reported once. */
	#failing = false;
	/** Its attempt ended, or its activation failed. */
	#detached = false;
	/** The retry's backoff after a failure, and its timer. */
	#delay: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		over: FollowedSource<unknown>,
		attach: FollowOverAttach<unknown, JsonValue>,
		owner: FollowOverOwner,
		observer: FollowObserver<JsonValue>,
		activation: Context,
	) {
		this.#over = over;
		this.#attach = attach;
		this.#owner = owner;
		this.#observer = observer;
		this.#activation = activation;
	}

	/**
	 * The first attachment (the activation's): the first one current when it resolves, to whichever value of `over` came
	 * last; waits for a value under the activation's deadline. One overtaken while it attached is dropped, its
	 * rejection too, and never holds up the newest. A rejection of the current one, or an absent address, is the
	 * activation's failure; nothing it acquired stays then.
	 */
	async first(): Promise<FollowAttachment<JsonValue>> {
		const first = Promise.withResolvers<FollowAttachment<JsonValue>>();
		this.#first = first;
		try {
			this.#over.dependents.add(this);
			this.#follow("value");
			return await awaitWithContext(first.promise, this.#activation);
		} catch (error) {
			this.#detach();
			throw error;
		}
	}

	/**
	 * `over` changed in the current batch (marking only): the current attachment's next call counts only once `over`'s
	 * value was read, and the follow reconciles with that value outside the batch. Not its frame: one that ends where it
	 * started (A, B, A in one batch) delivers none, and a registry failing without a last value none either.
	 */
	invalidate(): void {
		this.#moving = true;
		if (this.#idle !== undefined && !this.#checking) {
			this.#checking = true;
			// On the batch of `over`'s host (a registry value of another host commits there).
			this.#over.flushing(() => this.#checkIdle());
		}
		if (this.#reconciling) return;
		this.#reconciling = true;
		queueMicrotask(() => this.#reconcile());
	}

	sourceRetired(): void {}

	/**
	 * At the end of a batch that changed `over`, while idle: the value it committed, if another (also none, as a
	 * registry failing without a last good value), ends the wait, so the same value given back by a later batch before
	 * the reconciliation attaches again. A, B, A inside one batch commits A: the wait goes on.
	 */
	#checkIdle(): void {
		this.#checking = false;
		if (this.#idle !== undefined && this.#given() !== this.#idle) this.#idle = undefined;
	}

	/** Whether its attempt ended or was abandoned (its signal aborted): it starts, reports and retries nothing more. */
	get #sealed(): boolean {
		return this.#detached || this.#activation.abortSignal?.aborted === true;
	}

	/** Whether its attempt still activates (also after this follow's first attachment): a failure is the activation's. */
	get #activating(): boolean {
		return this.#first !== undefined || !this.#owner.live();
	}

	/**
	 * What `over` gives now: its value, its last good one while it is failed, `undefined` for none (also a registry
	 * failing with no last good value, its decision 5).
	 */
	#given(): unknown {
		const start = this.#over.start();
		return start.kind === "value" ? start.value : start.last?.value;
	}

	/**
	 * Attaches to the value of `over` now, read in the same turn (unless sealed, attached already, or `over` has none);
	 * `reason` is counted: a new value, or a retry after a failure.
	 */
	#follow(reason: "value" | "retry"): void {
		if (this.#sealed || this.#current !== undefined) return;
		// The runtime gets its old observation back before a new one: it may hold one at a time. Its detach may end the
		// attempt (its last holder released), which starts nothing more.
		this.#left();
		if (this.#sealed) return;
		const value = this.#given();
		this.#moving = false;
		if (this.#first !== undefined)
			this.#owner.waiting(value === undefined ? `a value of ${this.#named()}` : undefined);
		if (value === undefined) return;
		const attachment: Attachment = { for: value, held: NOTHING_HELD, observation: undefined };
		this.#current = attachment;
		void this.#run(attachment, reason);
	}

	/**
	 * After a batch that changed `over` (outside it: the runtime may not be called inside one): its value now, the same
	 * one as attached changes nothing (a registry recovering from a failure); another drops the current attachment and
	 * attaches the new one at once, a pending retry dropped unless it is for this value.
	 */
	#reconcile(): void {
		this.#reconciling = false;
		if (this.#sealed) return;
		const value = this.#given();
		this.#moving = false;
		if (this.#current !== undefined && this.#current.for === value) return;
		if (this.#current === undefined && this.#idle !== undefined && this.#idle === value) return;
		this.#letGo();
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#idle = undefined;
		this.#follow("value");
	}

	/**
	 * Attaches `attachment`: once resolved and still current, the activation's first, or one replacement with its
	 * newest value; one overtaken (or sealed meanwhile) is detached; a rejection or an absent address is a failure.
	 */
	async #run(attachment: Attachment, reason: "value" | "retry"): Promise<void> {
		const context = this.#first === undefined ? this.#owner.context : this.#activation;
		// The host's instruments: the object's context carries its first caller's telemetry, not the host's adapter.
		this.#owner.metrics.counter("chord.follow.attaches").add(1, { reason });
		let attached: FollowAttachment<JsonValue> | undefined;
		try {
			attached = await this.#attach(attachment.for, this.#observerOf(attachment), context);
		} catch (error) {
			// Overtaken (also by a change of `over` in this turn, before its reconciliation): dropped.
			if (this.#counts(attachment)) this.#fail(error);
			return;
		}
		if (!this.#counts(attachment) || this.#sealed) {
			if (this.#current === attachment) this.#current = undefined;
			attached?.detach();
			return;
		}
		if (attached === undefined) {
			this.#fail(
				new ChordError({ code: "unavailable", message: `${this.#owner.label}: the followed address is absent` }),
			);
			return;
		}
		const held = attachment.held;
		attachment.held = NOTHING_HELD;
		attachment.observation = attached;
		const value =
			held.kind === "value"
				? held.value
				: held.kind === "failed" && held.last !== undefined
					? held.last.value
					: attached.value;
		const first = this.#first;
		// Failed as it settled, while the activation waits for it: the activation's failure (R4), decided at this
		// settlement, not by what the followed source still queues until its own attachment resolves.
		if (first !== undefined && held.kind === "failed") {
			// Over for good before the runtime's cleanup runs (a cleanup that changes `over` starts nothing), which runs
			// here, inside the activation, its error staying the one selected now.
			this.#first = undefined;
			this.#current = undefined;
			this.#detach();
			this.#cleanUp(attached);
			first.reject(held.error);
			return;
		}
		this.#idle = undefined;
		if (first !== undefined) {
			this.#first = undefined;
			first.resolve({ value, detach: this.#release });
		} else {
			this.#failing = false;
			this.#delay = undefined;
			this.#observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, context);
		}
		// A failure it gave while it attached follows its replacement.
		if (held.kind === "failed") this.#observer.advance({ kind: "failed", error: held.error }, context);
	}

	/** The observer of `attachment`: while it attaches its calls are folded (`Held`), then they are passed on. */
	#observerOf(attachment: Attachment): FollowObserver<JsonValue> {
		return {
			advance: (call, context) => {
				if (!this.#counts(attachment)) return;
				if (attachment.observation === undefined) attachment.held = folded(attachment.held, call);
				// Settled while the object activates: a failure is the activation's now (R4), never one the followed
				// source still folds with later calls until its own attachment resolves.
				else if (call.kind === "failed" && this.#activating) this.#fail(call.error);
				else this.#observer.advance(call, context);
			},
			end: (end) => {
				if (this.#counts(attachment)) this.#ended(end);
			},
		};
	}

	/**
	 * Whether a call or end of `attachment` counts: it is the current one, and `over` still gives its value. Read only
	 * after `over` changed in this batch, before its call for the new value came: an attachment `over` gives no more is
	 * let go of then.
	 */
	#counts(attachment: Attachment): boolean {
		if (attachment !== this.#current) return false;
		if (!this.#moving) return true;
		if (this.#given() === attachment.for) {
			this.#moving = false;
			return true;
		}
		this.#letGo();
		return false;
	}

	/**
	 * The current attachment's runtime ended its observer (R4). Live: `failed` fails the member, `ended` lets the
	 * attachment go (the value stays, the next value of `over` attaches). While its attempt activates the end is the
	 * activation's, as for a plain follow.
	 */
	#ended(end: WatchEnd): void {
		if (end.kind === "failed") {
			this.#fail(end.error);
			return;
		}
		const ended = this.#current?.for;
		this.#letGo();
		if (this.#activating) this.#observer.end(end);
		else this.#idle = ended;
	}

	/**
	 * A failure of the current attachment: it is let go. While its attempt activates, the activation fails (R4); live,
	 * the member fails after what came before it (one failure call and one report per episode) and attaches again
	 * after the backoff or at the next value of `over`. Sealed: nothing more.
	 */
	#fail(error: unknown): void {
		const failed = this.#current?.for;
		this.#letGo();
		if (this.#sealed) return;
		if (this.#activating) {
			const first = this.#first;
			this.#first = undefined;
			if (first !== undefined) first.reject(error);
			else this.#observer.end({ kind: "failed", error });
			return;
		}
		this.#idle = failed;
		this.#delay = nextDelay(this.#delay);
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#idle = undefined;
			this.#follow("retry");
		}, this.#delay);
		if (this.#failing) return;
		this.#failing = true;
		this.#owner.report(handedOut(error));
		this.#observer.advance({ kind: "failed", error }, this.#owner.context);
	}

	/**
	 * The current attachment counts no more: forgotten now, with what it held; detached on the next microtask, outside
	 * any batch (its runtime's cleanup may call Chord, which a commit refuses).
	 */
	#letGo(): void {
		const current = this.#current;
		if (current === undefined) return;
		this.#current = undefined;
		current.held = NOTHING_HELD;
		const observation = current.observation;
		if (observation === undefined) return;
		this.#leaving.push(observation);
		if (this.#leaving.length === 1) queueMicrotask(() => this.#left());
	}

	/** Detaches the observations let go of (outside any batch). */
	#left(): void {
		const leaving = this.#leaving;
		if (leaving.length === 0) return;
		this.#leaving = [];
		for (const observation of leaving) this.#cleanUp(observation);
	}

	/** Detaches `observation`; a detach that throws is reported (`follow_failed`), never thrown out of a microtask. */
	#cleanUp(observation: FollowAttachment<JsonValue>): void {
		try {
			observation.detach();
		} catch (error) {
			this.#owner.report(handedOut(error));
		}
	}

	/** What `over` is, for the activation deadline's error. */
	#named(): string {
		const over = this.#over;
		return over instanceof RegistryValueSource ? `registry ${over.name}` : "its writable";
	}

	/** Its attempt ended, or its activation failed: `over` is followed no more, a pending retry dropped. */
	#detach(): void {
		this.#detached = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#idle = undefined;
		this.#over.dependents.delete(this);
		const current = this.#current;
		this.#current = undefined;
		// As a plain follow's at its attempt's end.
		this.#left();
		current?.observation?.detach();
	}
}

/** `held` with one more call of an attachment still attaching: a value replaces it, a failure keeps the last value. */
function folded(held: Held, call: WatchCall<JsonValue>): Held {
	if (call.kind === "value") return { kind: "value", value: call.value };
	const last = held.kind === "value" ? { value: held.value } : held.kind === "failed" ? held.last : undefined;
	return { kind: "failed", error: call.error, last };
}
