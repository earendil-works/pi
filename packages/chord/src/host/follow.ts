// Followed sources (slice 6b D9, R4, §3; ERNDL-1191): `self.follow(attach)` and `self.follow(over, attach)`, a Chord
// source over a synchronous observer of another runtime (Durable's `observeConversation`, `observeTaskGraph`,
// `observeDoc`). Attached during its attempt's activation, detached at the attempt's end; over a changing source it
// attaches again to each new value of that source, with one replacement and no failure in between. Calls inside a
// running batch (Durable adopting in the store's commit step) are marked in that batch, calls outside one are grouped
// into one batch on the next microtask, so a derive over two views of one commit computes once with both changes.

import { awaitWithContext, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import {
	type Batch,
	FollowedSource,
	handedOut,
	type NativeObserver,
	Source,
	type Subscriber,
	type WatchStart,
} from "../state/internal.ts";
import type { NativeWatchCall, Watch, WatchCall, WatchEnd } from "../watch.ts";
import { nextDelay } from "./backoff.ts";

/** The observer a followed runtime is given: Chord's watch shapes (Durable's `Observer`). */
export type FollowObserver<T> = {
	/** One change, synchronously and quickly: Chord only records it. */
	advance(call: WatchCall<T>, context: Context): void;
	/** The followed source ended: `failed` (its runtime failed), or `ended` for good. */
	end(end: WatchEnd): void;
};

/** What attaching gives: the value every later call starts from, and how to detach (Durable's `Observation`). */
export type FollowAttachment<T> = { readonly value: T; detach(): void };

/**
 * What `self.follow` takes: attaches `observer`, resolving with the attachment, `undefined` for an absent address.
 * The observer takes calls of any value (it only records them), so `T` is inferred from the attachment alone.
 */
export type FollowAttach<T> = (
	observer: FollowObserver<unknown>,
	context: Context,
) => Promise<FollowAttachment<T> | undefined>;

/**
 * What `self.follow(over, attach)` takes: attaches `observer` for `value`, a value of `over` (never `undefined`: then
 * nothing is followed), resolving with the attachment, `undefined` for an absent address.
 */
export type FollowOverAttach<S, T> = (
	value: S,
	observer: FollowObserver<unknown>,
	context: Context,
) => Promise<FollowAttachment<T> | undefined>;

/** What a followed source attaches: once for its attempt, or to each value of `over` (a registry value, a writable). */
export type Followed =
	| { readonly kind: "once"; readonly attach: FollowAttach<JsonValue> }
	| {
			readonly kind: "over";
			readonly over: FollowedSource<unknown>;
			readonly attach: FollowOverAttach<unknown, JsonValue>;
	  };

/** Who a followed source belongs to: its attempt (R4) and its context. */
export type FollowOwner = {
	readonly label: string;
	readonly context: Context;
	/**
	 * The followed runtime ended its observer: `failed` fails the attempt `transient` (live or activating, its retry
	 * attaches again); `ended` while the attempt activates fails it `transient` too (it would go live on a source that
	 * ended); `ended` while live is final for the source only. Over a changing source only while it activates.
	 */
	ended(end: WatchEnd): void;
	/** A source followed over a changing source failed while live (`follow_failed`), once per failure episode. */
	report(error: unknown): void;
};

/**
 * Checks the source of `self.follow(over, attach)` (declaration policy: TypeScript cannot tell a reference's member
 * or a derive from a registry value or a writable).
 */
export function followedOver(source: unknown, label: string): FollowedSource<unknown> {
	if (source instanceof FollowedSource) return source;
	throw new Error(`${label}: self.follow(over, attach) follows registry values and writables`);
}

/**
 * Where a followed source stands: its activation attaching (with the runtime's end when it came first), live, ended
 * by the runtime (once only: its value stays; detached at its attempt's end), or detached by its attempt.
 */
type FollowState =
	| { readonly kind: "attaching"; readonly end: WatchEnd | undefined }
	| { readonly kind: "live" }
	| { readonly kind: "ended" }
	| { readonly kind: "detached" };

/**
 * One attachment of the runtime's observer: the value of `over` it is for, its calls held until it resolved
 * (`undefined` from then on), and its detach once it resolved.
 */
type Attachment = {
	readonly for: unknown;
	held: WatchCall<JsonValue>[] | undefined;
	detach: (() => void) | undefined;
};

const NO_OPS: readonly Op[] = [];

const ENDED: WatchEnd = { kind: "ended" };

/**
 * A followed source: the runtime's value, the calls of its current attachment applied in order, its frames delivered
 * in the host's batch. Over a changing source, a failure of the current attachment makes it a failed member that
 * attaches again after a backoff.
 */
export class FollowSource extends Source {
	readonly #followed: Followed;
	readonly #owner: FollowOwner;
	#state: FollowState = { kind: "attaching", end: undefined };
	/** The attachment whose calls and end count; none over a changing source while it has none (no value, failed). */
	#current: Attachment | undefined;
	#value: JsonValue | undefined;
	/** Its failure while it is a failed member (over a changing source only), its last value kept. */
	#failed: { readonly error: unknown } | undefined;
	/** Over a changing source, the context its later attachments run under: its activation's (as a reader's reads). */
	#context: Context | undefined;
	/** Over a changing source: what follows `over` (made once), the activation's wait for a value, the retry's backoff. */
	#moves: NativeObserver<unknown> | undefined;
	#given: PromiseWithResolvers<void> | undefined;
	#delay: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** Calls of the current attachment made outside a batch, applied in one on the next microtask. */
	#queued: WatchCall<JsonValue>[] = [];
	/** Whether a microtask is queued to apply `#queued` in a batch of its own. */
	#scheduled = false;
	/**
	 * The runtime's end, still to reach the watches: `queued` after the queued calls' batch, `frame` after the current
	 * batch's frame (a retirement and an end in one batch: the retirement first).
	 */
	#ending: "none" | "queued" | "frame" = "none";
	/** The ops of the current batch's frame (kept only while watched), and whether a retirement came in it. */
	#ops: Op[] = [];
	#retired = false;
	#listed = false;

	constructor(followed: Followed, owner: FollowOwner, batch: Batch) {
		super(batch);
		this.#followed = followed;
		this.#owner = owner;
	}

	get value(): JsonValue {
		if (this.#failed !== undefined) throw this.#failed.error;
		if (this.#value === undefined) {
			throw new ChordError({
				code: "not_ready",
				message: `${this.#owner.label}: a followed source read before it attached`,
			});
		}
		return this.#value;
	}

	/** Its value, or while it is a failed member its failure and last value. */
	override start(): WatchStart {
		const failed = this.#failed;
		if (failed !== undefined) return { kind: "failed", error: failed.error, last: this.#value };
		return { kind: "value", value: this.value };
	}

	/**
	 * Attaches (activation, after the natives opened): the calls that came meanwhile apply on the attachment's value,
	 * and an end that came meanwhile takes effect then (the value stays). A rejected attachment, or `undefined` (an
	 * absent address), throws; an attachment arriving after its attempt detached the source is detached at once. Over
	 * a changing source it waits for a value, and an attachment that a newer value overtook while it attached (its
	 * rejection too) is dropped for one to the newest.
	 */
	async attach(context: Context): Promise<void> {
		const followed = this.#followed;
		if (followed.kind === "once") {
			const attachment = this.#begin(undefined);
			this.#settle(attachment, await followed.attach(this.#observer(attachment), context));
			return;
		}
		this.#context = context;
		this.#moves = { advance: (call) => this.#moved(call), end: () => {} };
		followed.over.subscribe(this.#moves);
		for (;;) {
			const value = await this.#present(followed.over, context);
			const attachment = this.#begin(value);
			let attached: FollowAttachment<JsonValue> | undefined;
			try {
				attached = await followed.attach(value, this.#observer(attachment), context);
			} catch (error) {
				if (this.#current === attachment || this.#state.kind !== "attaching") throw error;
				continue;
			}
			if (this.#current === attachment || this.#state.kind !== "attaching") {
				this.#settle(attachment, attached);
				return;
			}
			attached?.detach();
		}
	}

	/**
	 * Its attempt ended: the observer is detached (also after the runtime ended it), `over` no longer followed, a
	 * pending retry dropped, and its watches end `ended`.
	 */
	detach(): void {
		const current = this.#current;
		this.#state = { kind: "detached" };
		this.#current = undefined;
		this.#queued = [];
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#followed.kind === "over" && this.#moves !== undefined) this.#followed.over.unsubscribe(this.#moves);
		current?.detach?.();
		this.endWatches();
	}

	/** A watch of an ended source opens at its value and ends `ended` at once. */
	override openWatch(context: Context): Watch<JsonValue> {
		const watch = super.openWatch(context);
		if (this.#finished) watch.end(ENDED);
		return watch;
	}

	/** A subscriber of an ended source (a reference's watch through its member) ends `ended` at once. */
	override subscribe(subscriber: Subscriber): void {
		if (this.#finished) subscriber.end(ENDED);
		else super.subscribe(subscriber);
	}

	deliver(context: Context): void {
		const ops = this.#ops;
		const retired = this.#retired;
		this.#ops = [];
		this.#retired = false;
		this.#listed = false;
		const failed = this.#failed;
		if (failed !== undefined) this.failWatches(failed.error, context);
		else this.publish(this.#value!, ops.length === 0 ? NO_OPS : ops, retired, context);
		if (this.#ending === "frame") {
			this.#ending = "none";
			this.endWatchesAfterDelivery();
		}
	}

	/** Whether nothing reaches its watches any more: ended by the runtime (what it gave delivered) or detached. */
	get #finished(): boolean {
		const { kind } = this.#state;
		return (kind === "ended" && this.#ending === "none") || kind === "detached";
	}

	/** A new attachment for `value` of `over`, the current one from now on: its calls held until it resolved. */
	#begin(value: unknown): Attachment {
		const attachment: Attachment = { for: value, held: [], detach: undefined };
		this.#current = attachment;
		return attachment;
	}

	/** The observer of `attachment`: its calls and end count only while it is the current one. */
	#observer(attachment: Attachment): FollowObserver<JsonValue> {
		return {
			advance: (call) => {
				if (this.#current !== attachment) return;
				if (attachment.held === undefined) this.#advance(call);
				else attachment.held.push(call);
			},
			end: (end) => this.#end(attachment, end),
		};
	}

	/** The activation's attachment resolved: the source takes its value moved on by the held calls, and goes live. */
	#settle(attachment: Attachment, attached: FollowAttachment<JsonValue> | undefined): void {
		if (attached === undefined) {
			throw new ChordError({ code: "unavailable", message: `${this.#owner.label}: the followed address is absent` });
		}
		const state = this.#state;
		if (state.kind !== "attaching") {
			attached.detach();
			return;
		}
		// Nothing watches it yet (members are checked after this): the held calls only move the value on.
		this.#value = this.#take(attachment, attached);
		this.#state = state.end?.kind === "ended" ? { kind: "ended" } : { kind: "live" };
	}

	/** Takes a resolved attachment: its detach, and its value moved on by the calls it held, which it holds no more. */
	#take(attachment: Attachment, attached: FollowAttachment<JsonValue>): JsonValue {
		let value = attached.value;
		for (const call of attachment.held!) if (call.kind === "value") value = call.value;
		attachment.held = undefined;
		attachment.detach = () => attached.detach();
		return value;
	}

	/** The value of `over` to attach to during the activation: waits (under its deadline) while it has none. */
	async #present(over: FollowedSource<unknown>, context: Context): Promise<unknown> {
		for (;;) {
			const value = over.value;
			if (value !== undefined) return value;
			this.#given = Promise.withResolvers();
			await awaitWithContext(this.#given.promise, context);
		}
	}

	/**
	 * `over` has another value (inside the batch that changed it): the current attachment counts no more. While the
	 * activation attaches, it attaches to the newest; while live, the old one is detached and the newest attached
	 * outside the batch (the runtime may not be called inside it), at once, a pending retry dropped.
	 */
	#moved(call: NativeWatchCall<unknown>): void {
		// A failed composition changes nothing: the value followed is still its last good one.
		if (call.kind !== "value") return;
		const { kind } = this.#state;
		if (kind === "detached") return;
		const old = this.#current;
		this.#current = undefined;
		if (kind === "attaching") {
			this.#given?.resolve();
			return;
		}
		clearTimeout(this.#timer);
		this.#timer = undefined;
		queueMicrotask(() => {
			old?.detach?.();
			this.#follow();
		});
	}

	/** Attaches to the value of `over` now, unless detached, attached already, or `over` has none. */
	#follow(): void {
		if (this.#state.kind !== "live" || this.#current !== undefined || this.#followed.kind !== "over") return;
		const value = this.#followed.over.value;
		if (value !== undefined) void this.#reattach(this.#followed.attach, value);
	}

	/**
	 * Attaches to `value` while live: once resolved and still current, one replacement with its newest value, then its
	 * later calls; a superseded one is detached; a rejection or an absent address makes the source a failed member.
	 */
	async #reattach(attach: FollowOverAttach<unknown, JsonValue>, value: unknown): Promise<void> {
		const attachment = this.#begin(value);
		let attached: FollowAttachment<JsonValue> | undefined;
		try {
			attached = await attach(value, this.#observer(attachment), this.#context!);
		} catch (error) {
			if (this.#current === attachment) this.#fail(error);
			return;
		}
		if (this.#current !== attachment) {
			attached?.detach();
			return;
		}
		if (attached === undefined) {
			this.#fail(
				new ChordError({ code: "unavailable", message: `${this.#owner.label}: the followed address is absent` }),
			);
			return;
		}
		const newest = this.#take(attachment, attached);
		this.#delay = undefined;
		this.#advance({ kind: "value", value: newest, ops: [["r", newest]], retired: false });
	}

	/**
	 * A failure of the current attachment while live, over a changing source: it is let go, and the source becomes a
	 * failed member in a batch after what came before it (its watches one failure call, its owner one report per
	 * episode), retried after the backoff or at the next value of `over`.
	 */
	#fail(error: unknown): void {
		this.#letGo();
		this.#delay = nextDelay(this.#delay);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#follow();
		}, this.#delay);
		if (this.#failed !== undefined) return;
		const fail = () => {
			if (this.#state.kind !== "live" || this.#failed !== undefined) return;
			this.#applyQueued();
			this.#owner.report(handedOut(error));
			this.#failed = { error };
			this.#ops = [];
			this.#mark();
		};
		if (this.batch.running) fail();
		else this.batch.soon(fail, this.#owner.context);
	}

	/** The current attachment counts no more: detached, its value let go of. */
	#letGo(): void {
		const current = this.#current;
		this.#current = undefined;
		current?.detach?.();
	}

	/**
	 * A call of the current attachment: inside a running batch, applied there (after what was queued); outside one,
	 * queued for one batch on the next microtask.
	 */
	#advance(call: WatchCall<JsonValue>): void {
		const { kind } = this.#state;
		if (kind === "ended" || kind === "detached") return;
		if (!this.batch.running) {
			this.#queued.push(call);
			this.#schedule();
			return;
		}
		this.#applyQueued();
		this.#apply(call);
	}

	/**
	 * The runtime ended the observer of `attachment` (R4); only the current attachment's end counts, and over a
	 * changing source only while `over` still has its value. While the activation attaches, its attempt is told.
	 * Followed once: `ended` is final (what came before reaches the watches first, the value staying), `failed` fails
	 * its attempt, which detaches the source. Over a changing source: `failed` makes it a failed member, `ended` lets
	 * the attachment go (the value stays, the next value of `over` attaches).
	 */
	#end(attachment: Attachment, end: WatchEnd): void {
		if (attachment !== this.#current) return;
		const followed = this.#followed;
		// Read now: the call for a new value of `over` may come later in this batch than this end.
		if (followed.kind === "over" && followed.over.value !== attachment.for) return;
		const state = this.#state;
		if (state.kind === "ended" || state.kind === "detached") return;
		if (state.kind === "attaching") {
			if (state.end === undefined) this.#state = { kind: "attaching", end };
			this.#owner.ended(end);
			return;
		}
		if (followed.kind === "over") {
			if (end.kind === "failed") this.#fail(end.error);
			else this.#letGo();
			return;
		}
		if (end.kind === "ended") {
			this.#state = { kind: "ended" };
			if (this.#queued.length > 0 && !this.batch.running) this.#ending = "queued";
			else {
				// Inside a running batch the queued calls join it (none is queued outside one: they wait for their batch).
				this.#applyQueued();
				this.#endAfterFrame();
			}
		}
		this.#owner.ended(end);
	}

	/** The watches end once this batch's frame reached them, at once when the source is in none. */
	#endAfterFrame(): void {
		// No frame to wait for (nothing watches it): the end is over now, and a later watch ends at once.
		this.#ending = this.#listed ? "frame" : "none";
		if (!this.#listed) this.endWatchesAfterDelivery();
	}

	#schedule(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		this.batch.soon(() => {
			this.#scheduled = false;
			const { kind } = this.#state;
			if (kind === "live" || kind === "ended") this.#applyQueued();
			if (this.#ending === "queued") this.#endAfterFrame();
		}, this.#owner.context);
	}

	#applyQueued(): void {
		const queued = this.#queued;
		if (queued.length === 0) return;
		this.#queued = [];
		for (const call of queued) this.#apply(call);
	}

	/**
	 * Applies one value call inside the running batch: the new value (a failed member's next is a replacement, which
	 * ends its failure), its ops for the frame, the source marked once.
	 */
	#apply(call: WatchCall<JsonValue>): void {
		// The runtime's failures are final: it ends its observer instead of sending one.
		if (call.kind !== "value") return;
		this.#value = call.value;
		this.#failed = undefined;
		if (call.retired) this.#retired = true;
		if (this.watched) for (const op of call.ops) this.#ops.push(op);
		this.#mark();
		if (call.retired) this.retiredInBatch();
	}

	/** Marks a change in the running batch: listed once for its frame when watched, its dependents marked. */
	#mark(): void {
		if (!this.watched) {
			this.changed();
			return;
		}
		if (this.#listed) return;
		this.#listed = true;
		this.changed();
	}
}
