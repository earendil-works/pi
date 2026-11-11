// Events (decision "Events: fire-and-forget members"): the third member kind's delivery on one host. An emit, or an
// event arriving over a link, takes the host's next counter value and waits in the host's list for the event flush, a
// microtask its first entry queues; commits flush synchronously, so every state message published before the flush runs
// is sent before it. At the flush each entry goes from its node (an object's own source, a re-exposed member, an older
// version's mapping, a remote object's member) to the taps of the bindings made before it (a hold over a link, a
// reference, the re-exposing nodes behind a reference): first every link's message, then the listeners, outside the
// publication's reentrancy fence, in entry order, then subscription order.

import type { Context } from "../context/index.ts";
import type { EventSource, EventSubscription } from "../contracts/index.ts";
import type { ChordError } from "../data/index.ts";
import type { JsonValue } from "../json.ts";
import type { Part } from "../link/internal.ts";
import type { ChordMetrics } from "../telemetry.ts";

/** An event's listener, as `EventMember.on` takes it. */
export type EventListener = (event: { readonly value: JsonValue; readonly at: number }) => void;

/**
 * One event waiting for the flush: its node, its value and stamp (the emitting host's `Date.now()`), the host's counter
 * value it took, and its value encoded for links once one needs it (one encode per representation, `part`).
 */
export type EventEntry = {
	readonly node: EventNode;
	readonly value: JsonValue;
	readonly at: number;
	readonly n: number;
	part: Part | undefined;
};

/**
 * Where a node delivers: one binding (a hold over a link, a reference, an older version's mapping), made when the
 * host's counter was `boundAt`; it gets only entries with a higher counter value.
 */
export type Tap = { readonly boundAt: number; readonly deliver: (entry: EventEntry, flush: EventFlush) => void };

/** What sends a flush's events on a link once every entry was visited: one message per link and origin. */
export interface EventSender {
	sendEvents(): void;
}

/** What taps hand to the flush while it visits them: a link's sender (once per flush), a listener's call. */
export type EventFlush = {
	readonly sending: (sender: EventSender) => void;
	readonly call: (subscription: Subscription, entry: EventEntry) => void;
};

/** What a host's events report: a listener that threw (its subscription ended). */
export type EventReport = (error: { readonly kind: "listener_error"; readonly error: unknown }) => void;

/** What an object's own source checks and counts with: the host's events, and its attempt's seal (`released` after). */
export type SourceOwner = { readonly events: HostEvents; readonly sealed: () => ChordError | undefined };

/**
 * A host's events: its emit counter, its list waiting for the flush and the flush itself, and the order of its
 * subscriptions. Nothing is kept once a flush ran.
 */
export class HostEvents {
	readonly metrics: ChordMetrics;
	readonly #report: EventReport;
	#counter = 0;
	#subscriptions = 0;
	#list: EventEntry[] = [];

	constructor(metrics: ChordMetrics, report: EventReport) {
		this.metrics = metrics;
		this.#report = report;
	}

	/** The counter's value now: a binding made now gets only events pushed after it. */
	get counter(): number {
		return this.#counter;
	}

	/** Appends an event of `node` stamped `at` with the counter's next value; the first of a turn queues the flush. */
	push(node: EventNode, value: JsonValue, at: number): void {
		const n = ++this.#counter;
		if (this.#list.length === 0) queueMicrotask(() => this.#flush());
		this.#list.push({ node, value, at, n, part: undefined });
	}

	/** The next subscription's place in the listeners' order. */
	nextSubscription(): number {
		return ++this.#subscriptions;
	}

	/**
	 * Visits every entry (its node's taps), sends what links collected, then calls the listeners in entry order, then
	 * subscription order; what they emit goes into the next flush.
	 */
	#flush(): void {
		const entries = this.#list;
		this.#list = [];
		const senders: EventSender[] = [];
		const calls: (readonly [Subscription, EventEntry])[] = [];
		const flush: EventFlush = {
			sending: (sender) => void senders.push(sender),
			call: (subscription, entry) => void calls.push([subscription, entry]),
		};
		for (const entry of entries) entry.node.deliver(entry, flush);
		for (const sender of senders) sender.sendEvents();
		// Grouped by entry already; an entry reaching several references is put in subscription order (stable).
		if (calls.length > 1) calls.sort(([a, first], [b, second]) => first.n - second.n || a.order - b.order);
		for (const [subscription, entry] of calls) subscription.call(entry, this.#report);
	}
}

/**
 * A source of events on a host: its taps are the bindings it delivers to. An object's own source, a re-exposed member,
 * an older version's mapping and a remote object's member are nodes.
 */
export class EventNode {
	readonly #taps = new Set<Tap>();

	/** Whether any binding taps it: an event arriving for a node nobody taps is dropped on arrival. */
	get tapped(): boolean {
		return this.#taps.size > 0;
	}

	/** `tap`'s binding gets this node's entries from now on (those with a higher counter value than its `boundAt`). */
	tap(tap: Tap): void {
		this.#taps.add(tap);
	}

	/** `tap`'s binding ended. */
	untap(tap: Tap): void {
		this.#taps.delete(tap);
	}

	/** Delivers `entry` to every tap whose binding was made before it (`boundAt < n`). */
	deliver(entry: EventEntry, flush: EventFlush): void {
		for (const tap of this.#taps) if (tap.boundAt < entry.n) tap.deliver(entry, flush);
	}

	/** Its instance ended: no binding taps it any more. */
	clear(): void {
		this.#taps.clear();
	}
}

/**
 * A subscription (`EventMember.on`): its listener until `stop`, its context's abort or its owner's end; a call due when
 * it stopped is skipped. A listener that throws is reported (`listener_error`) and its subscription ends.
 */
export class Subscription implements EventSubscription {
	/** Its place in the listeners' order (the host's subscriptions, in the order they were made). */
	readonly order: number;
	#listener: EventListener | undefined;
	/** Its context's signal and what tells its owner it stopped, both let go at `stop`: a kept handle keeps neither. */
	#signal: AbortSignal | undefined;
	#stopped: ((subscription: Subscription) => void) | undefined;
	readonly #abort = (): void => this.stop();

	constructor(
		order: number,
		listener: EventListener,
		context: Context,
		stopped: (subscription: Subscription) => void,
	) {
		this.order = order;
		this.#listener = listener;
		this.#signal = context.abortSignal;
		this.#stopped = stopped;
		this.#signal?.addEventListener("abort", this.#abort, { once: true });
	}

	stop(): void {
		const stopped = this.#stopped;
		if (stopped === undefined) return;
		this.#listener = undefined;
		this.#stopped = undefined;
		this.#signal?.removeEventListener("abort", this.#abort);
		this.#signal = undefined;
		stopped(this);
	}

	/** Calls its listener with `entry`'s value and stamp, unless it stopped. */
	call(entry: EventEntry, report: EventReport): void {
		const listener = this.#listener;
		if (listener === undefined) return;
		try {
			listener({ value: entry.value, at: entry.at });
		} catch (error) {
			report({ kind: "listener_error", error });
			this.stop();
		}
	}
}

/**
 * Subscribes `listener` under `context` with `install` (its owner keeps it and taps for it), at once; rejects with the
 * abort reason of an aborted context (installing nothing).
 */
export function subscribe(
	events: HostEvents,
	listener: EventListener,
	context: Context,
	install: (subscription: Subscription) => void,
	stopped: (subscription: Subscription) => void,
): Promise<EventSubscription> {
	const signal = context.abortSignal;
	if (signal?.aborted) return Promise.reject(signal.reason);
	const subscription = new Subscription(events.nextSubscription(), listener, context, stopped);
	install(subscription);
	return Promise.resolve(subscription);
}

/**
 * An object's own source (`self.events<T>()`), owned by its attempt: an emit takes the host's next counter value and
 * waits for the flush; its own `on` subscriptions tap it from their subscription on. After the seal an emit throws.
 */
export class OwnEventSource extends EventNode implements EventSource<JsonValue> {
	readonly #owner: SourceOwner;
	/** Its own subscriptions (the owner's `on`), each with its tap; made by the first. */
	#subscriptions: Map<Subscription, Tap> | undefined;

	constructor(owner: SourceOwner) {
		super();
		this.#owner = owner;
	}

	/** Whether `owner` owns it: an object implements its event members with its own attempt's sources only. */
	ownedBy(owner: SourceOwner): boolean {
		return this.#owner === owner;
	}

	emit(value: JsonValue): void {
		const { events, sealed } = this.#owner;
		const error = sealed();
		if (error !== undefined) throw error;
		events.metrics.counter("chord.events.emitted").add(1);
		events.push(this, value, Date.now());
	}

	on(listener: EventListener, context: Context): Promise<EventSubscription> {
		const { events } = this.#owner;
		return subscribe(
			events,
			listener,
			context,
			(subscription) => {
				const tap: Tap = { boundAt: events.counter, deliver: (entry, flush) => flush.call(subscription, entry) };
				this.#subscriptions ??= new Map();
				this.#subscriptions.set(subscription, tap);
				this.tap(tap);
			},
			(subscription) => {
				const tap = this.#subscriptions?.get(subscription);
				if (tap === undefined) return;
				this.#subscriptions!.delete(subscription);
				this.untap(tap);
			},
		);
	}

	/** Its attempt ended: every binding's tap goes, and its own subscriptions end. */
	detach(): void {
		this.clear();
		for (const subscription of [...(this.#subscriptions?.keys() ?? [])]) subscription.stop();
	}
}
