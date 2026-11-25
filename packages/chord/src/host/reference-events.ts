// A reference's event members (decision "Events: fire-and-forget members"): what a reference exposes per event member
// (`on` only, never `emit`), what an object re-exposing one implements its member with, and a binding's taps on the
// instance it is bound to. Per member a binding keeps its subscriptions and the re-exposing nodes it feeds, tapped on
// the instance's node from the counter value of its binding to that instance; it moves them to every new instance it
// binds (an older version's mapping; a variant without the member: none), and keeps them untapped while it points at
// nothing. Nothing missed is replayed.

import type { Context } from "../context/index.ts";
import type { EventMember, EventSubscription } from "../contracts/index.ts";
import type { JsonValue } from "../json.ts";
import {
	type EventEntry,
	type EventFlush,
	type EventListener,
	EventNode,
	type Subscription,
	type Tap,
} from "./events.ts";
import type { Attachable, Binding } from "./reference.ts";

/** A reference's event member: its listeners follow the reference's binding. */
export class ReferenceEvents implements EventMember<JsonValue> {
	readonly binding: Binding;
	readonly member: string;

	constructor(binding: Binding, member: string) {
		this.binding = binding;
		this.member = member;
	}

	on(listener: EventListener, context: Context): Promise<EventSubscription> {
		return this.binding.subscribeEvents(this.member, listener, context);
	}
}

/**
 * An object's event member re-exposing a reference's (`ReferenceEvents`): the reference feeds it what it receives,
 * value and stamp unchanged, from the attempt's members check until its end; its own taps are the object's bindings.
 */
export class ReexposedEvents extends EventNode {
	readonly #source: ReferenceEvents;

	constructor(source: ReferenceEvents) {
		super();
		this.#source = source;
	}

	/** Fed by its reference from now on. */
	attach(): void {
		this.#source.binding.forwardEvents(this.#source.member, this);
	}

	/** Its attempt ended: no longer fed, no binding taps it. */
	detach(): void {
		this.#source.binding.unforwardEvents(this.#source.member, this);
		this.clear();
	}
}

/** One event member of a binding: its subscriptions, the nodes it feeds, and its tap on the instance's node. */
type MemberTaps = {
	readonly subscriptions: Set<Subscription>;
	readonly forwards: Set<EventNode>;
	attached: { readonly node: EventNode; readonly tap: Tap } | undefined;
};

/**
 * A binding's taps: per event member used (a subscription, a re-exposing node), tapped on the node of the instance it
 * points at, at its version; a member nobody uses any more is untapped and forgotten.
 */
export class ReferenceEventTaps {
	readonly #members = new Map<string, MemberTaps>();
	readonly #version: number;
	/** The instance it points at and the counter value of its binding to it; none while it points at nothing. */
	#at: { readonly instance: Attachable; readonly boundAt: number } | undefined;

	constructor(version: number, at: { readonly instance: Attachable; readonly boundAt: number } | undefined) {
		this.#version = version;
		this.#at = at;
	}

	/** Its binding points at `at`'s instance now, bound at `at.boundAt` (or at nothing): every member moves there. */
	retarget(at: { readonly instance: Attachable; readonly boundAt: number } | undefined): void {
		this.#at = at;
		for (const [member, taps] of this.#members) this.#place(member, taps);
	}

	/** Adds `subscription` to `member`'s listeners. */
	subscribe(member: string, subscription: Subscription): void {
		this.#taps(member).subscriptions.add(subscription);
	}

	/** `subscription` stopped. */
	unsubscribe(member: string, subscription: Subscription): void {
		const taps = this.#members.get(member);
		if (taps === undefined) return;
		taps.subscriptions.delete(subscription);
		this.#forgetUnused(member, taps);
	}

	/** Feeds `node` (an object re-exposing this member) what `member` receives. */
	forward(member: string, node: EventNode): void {
		this.#taps(member).forwards.add(node);
	}

	/** Stops feeding `node`. */
	unforward(member: string, node: EventNode): void {
		const taps = this.#members.get(member);
		if (taps === undefined) return;
		taps.forwards.delete(node);
		this.#forgetUnused(member, taps);
	}

	/** Its binding ended: every subscription stops, nothing is tapped or fed any more. */
	end(): void {
		const members = [...this.#members.values()];
		this.#members.clear();
		for (const taps of members) {
			if (taps.attached !== undefined) taps.attached.node.untap(taps.attached.tap);
			for (const subscription of taps.subscriptions) subscription.stop();
		}
	}

	/** `member`'s record, made and tapped by its first use. */
	#taps(member: string): MemberTaps {
		let taps = this.#members.get(member);
		if (taps === undefined) {
			taps = { subscriptions: new Set(), forwards: new Set(), attached: undefined };
			this.#members.set(member, taps);
			this.#place(member, taps);
		}
		return taps;
	}

	/** Taps `member` on the node of the instance pointed at (none: a variant without it, or nothing pointed at). */
	#place(member: string, taps: MemberTaps): void {
		if (taps.attached !== undefined) taps.attached.node.untap(taps.attached.tap);
		taps.attached = undefined;
		const at = this.#at;
		const node = at?.instance.eventNode(member, this.#version);
		if (at === undefined || node === undefined) return;
		const tap: Tap = { boundAt: at.boundAt, deliver: (entry, flush) => deliver(taps, entry, flush) };
		node.tap(tap);
		taps.attached = { node, tap };
	}

	/** Untaps and forgets `member` once nobody uses it. */
	#forgetUnused(member: string, taps: MemberTaps): void {
		if (taps.subscriptions.size > 0 || taps.forwards.size > 0) return;
		this.#members.delete(member);
		if (taps.attached !== undefined) taps.attached.node.untap(taps.attached.tap);
	}
}

/** One entry for a member: its listeners' calls, and the nodes re-exposing it, which deliver to their own bindings. */
function deliver(taps: MemberTaps, entry: EventEntry, flush: EventFlush): void {
	for (const subscription of taps.subscriptions) flush.call(subscription, entry);
	for (const node of taps.forwards) node.deliver(entry, flush);
}
