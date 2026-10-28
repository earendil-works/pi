// Followed sources (slice 6b D9, R4, §3): `self.follow(attach)`, a Chord source over a synchronous observer of another
// runtime (Durable's `observeConversation`, `observeTaskGraph`, `observeDoc`). Attached during its attempt's
// activation, detached at the attempt's end. Calls inside a running batch (Durable adopting in the store's commit step)
// are marked in that batch, calls outside one are grouped into one batch on the next microtask, so a derive over two
// views of one commit computes once with both changes.

import type { Context } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Watch, WatchCall, WatchEnd } from "../../watch.ts";
import { ChordError } from "../data/index.ts";
import { type Batch, Source, type Subscriber } from "../state/internal.ts";

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

/** Who a followed source belongs to: its attempt (R4) and its context. */
export type FollowOwner = {
	readonly label: string;
	readonly context: Context;
	/**
	 * The followed runtime ended its observer: `failed` fails the attempt `transient` (live or activating, its retry
	 * attaches again); `ended` while the attempt activates fails it `transient` too (it would go live on a source that
	 * ended); `ended` while live is final for the source only.
	 */
	ended(end: WatchEnd): void;
};

/**
 * Where a followed source stands: waiting for its attachment (with the runtime's end when it came first), attached,
 * ended by the runtime (its value stays; detached at its attempt's end), or detached by its attempt.
 */
type FollowState =
	| { readonly kind: "attaching"; readonly end: WatchEnd | undefined }
	| { readonly kind: "attached"; readonly detach: () => void }
	| { readonly kind: "ended"; readonly detach: () => void }
	| { readonly kind: "detached" };

const NO_OPS: readonly Op[] = [];

const ENDED: WatchEnd = { kind: "ended" };

/** A followed source: the runtime's value, its calls applied in order, its frames delivered in the host's batch. */
export class FollowSource extends Source {
	readonly #attach: FollowAttach<JsonValue>;
	readonly #owner: FollowOwner;
	#state: FollowState = { kind: "attaching", end: undefined };
	#value: JsonValue | undefined;
	/** Calls not applied yet: before the attachment resolved, and outside a batch until the next microtask. */
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

	constructor(attach: FollowAttach<JsonValue>, owner: FollowOwner, batch: Batch) {
		super(batch);
		this.#attach = attach;
		this.#owner = owner;
	}

	get value(): JsonValue {
		if (this.#value === undefined) {
			throw new ChordError({
				code: "not_ready",
				message: `${this.#owner.label}: a followed source read before it attached`,
			});
		}
		return this.#value;
	}

	/**
	 * Attaches (activation, after the natives opened): the calls that came meanwhile apply on the attachment's value,
	 * and an end that came meanwhile takes effect then (the value stays). A rejected attachment, or `undefined` (an
	 * absent address), throws; an attachment arriving after its attempt detached the source is detached at once.
	 */
	async attach(context: Context): Promise<void> {
		const observer: FollowObserver<JsonValue> = {
			advance: (call) => this.#advance(call),
			end: (end) => this.#end(end),
		};
		const attached = await this.#attach(observer, context);
		if (attached === undefined) {
			throw new ChordError({ code: "unavailable", message: `${this.#owner.label}: the followed address is absent` });
		}
		const state = this.#state;
		const detach = () => attached.detach();
		if (state.kind !== "attaching") {
			detach();
			return;
		}
		this.#value = attached.value;
		// Nothing watches it yet (members are checked after this): the queued calls only move the value on.
		for (const call of this.#queued) if (call.kind === "value") this.#value = call.value;
		this.#queued = [];
		this.#state = state.end?.kind === "ended" ? { kind: "ended", detach } : { kind: "attached", detach };
	}

	/** Its attempt ended: the observer is detached (also after the runtime ended it) and its watches end `ended`. */
	detach(): void {
		const state = this.#state;
		this.#state = { kind: "detached" };
		this.#queued = [];
		if (state.kind === "attached" || state.kind === "ended") state.detach();
		this.endWatches();
	}

	/** A watch of an ended source opens at its value and ends `ended` at once. */
	override openWatch(context: Context): Watch<JsonValue> {
		const watch = super.openWatch(context);
		if (this.#over) watch.end(ENDED);
		return watch;
	}

	/** A subscriber of an ended source (a reference's watch through its member source) ends `ended` at once. */
	override subscribe(subscriber: Subscriber): void {
		if (this.#over) subscriber.end(ENDED);
		else super.subscribe(subscriber);
	}

	deliver(context: Context): void {
		const ops = this.#ops;
		const retired = this.#retired;
		this.#ops = [];
		this.#retired = false;
		this.#listed = false;
		this.publish(this.#value!, ops.length === 0 ? NO_OPS : ops, retired, context);
		if (this.#ending === "frame") {
			this.#ending = "none";
			this.endWatchesAfterDelivery();
		}
	}

	/** Whether nothing reaches its watches any more: ended by the runtime (what it gave delivered) or detached. */
	get #over(): boolean {
		const { kind } = this.#state;
		return (kind === "ended" && this.#ending === "none") || kind === "detached";
	}

	/**
	 * A call of the runtime: before the attachment, queued; inside a running batch, applied there (after what was
	 * queued); outside one, queued for one batch on the next microtask.
	 */
	#advance(call: WatchCall<JsonValue>): void {
		const { kind } = this.#state;
		if (kind === "ended" || kind === "detached") return;
		if (kind === "attaching" || !this.batch.running) {
			this.#queued.push(call);
			if (kind === "attached") this.#schedule();
			return;
		}
		this.#applyQueued();
		this.#apply(call);
	}

	/**
	 * The runtime ended its observer (R4); its attempt is told. `ended` is final: what came before reaches the watches
	 * first (the queued calls in their batch, a call of the running batch in its frame), then they end, the value
	 * staying. A `failed` attempt detaches the source.
	 */
	#end(end: WatchEnd): void {
		const state = this.#state;
		if (state.kind === "ended" || state.kind === "detached") return;
		if (state.kind === "attaching") {
			if (state.end === undefined) this.#state = { kind: "attaching", end };
			this.#owner.ended(end);
			return;
		}
		if (end.kind === "ended") {
			this.#state = { kind: "ended", detach: state.detach };
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
			if (kind === "attached" || kind === "ended") this.#applyQueued();
			if (this.#ending === "queued") this.#endAfterFrame();
		}, this.#owner.context);
	}

	#applyQueued(): void {
		const queued = this.#queued;
		if (queued.length === 0) return;
		this.#queued = [];
		for (const call of queued) this.#apply(call);
	}

	/** Applies one value call inside the running batch: the new value, its ops for the frame, the source marked once. */
	#apply(call: WatchCall<JsonValue>): void {
		// The runtime's failures are final: it ends its observer instead of sending one.
		if (call.kind !== "value") return;
		this.#value = call.value;
		if (call.retired) this.#retired = true;
		if (!this.watched) {
			this.changed();
			if (call.retired) this.retiredInBatch();
			return;
		}
		for (const op of call.ops) this.#ops.push(op);
		if (!this.#listed) {
			this.#listed = true;
			this.changed();
		}
		if (call.retired) this.retiredInBatch();
	}
}
