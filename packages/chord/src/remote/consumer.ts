// The consumer side of a link (§7, §22, W1): the holds this host's own remote references sent on it, by this side's
// ids, the calls through them within the peer's call window, and each `bound` and `state` message applied to their
// replicas as one batch, then acknowledged. Messages with an origin answer holds this host relays: they go to that
// origin's provider side; the calls this host relays for an origin wait here within the same window (one per origin).
// Each `event` message of its own holds is consumed (its values handed to the host's event flush, or deliberately
// dropped) and acknowledged with one event `ack` per inbound turn (decision "Events: fire-and-forget members"). On a
// host without a compressor, the deflated parts of this host's own holds and calls are inflated asynchronously first,
// and the message is handled once they are.

import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import type { Context } from "../context/index.ts";
import { type MethodData, takesNoArgs } from "../contracts/internal.ts";
import { ChordError, isChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import {
	type BoundEntry,
	type ConsumerMessage,
	type DeflatedPart,
	errorFromWire,
	type Message,
	type Part,
	parsePayload,
	payloadPart,
	type StateEntry,
	type WireEvent,
} from "../link/internal.ts";
import { carrierOf } from "../telemetry.ts";
import { CallWindow, type QueuedCall } from "./calls.ts";
import { actingFor } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { RemoteObject } from "./remote-object.ts";

/** A reply to a call. */
type Reply = Extract<Message, { readonly kind: "result" | "error" }>;

/**
 * A call through this side: waiting for a slot of the call window (no id yet), then in flight under its id until its
 * reply, its abort, its hold's release or `gone`, or the link's close.
 */
type OutgoingCall = {
	readonly hold: number;
	/** The method's index in the bound variant and its arguments' part. */
	readonly method: number;
	readonly args: Part | undefined;
	readonly segments: readonly Uint8Array[] | undefined;
	/** The caller's trace carrier (its `chord.call` span's), when its adapter propagates. */
	readonly trace: TelemetryCarrier | undefined;
	/** Whether the caller is old work of a reload here (`call.old`: the provider routes it to open old attempts). */
	readonly old: boolean;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	id: number | undefined;
	send(): void;
};

/**
 * The consumer side of one link. Ids are its own counters, from 0; a reply naming an id this side gave up is ignored
 * (Q1). When the link closes, every call rejects `unavailable` (never resent) and its path tells every holder.
 */
export class ConsumerSide {
	readonly #link: HostLink;
	readonly #entries = new Map<number, RemoteObject>();
	readonly #calls = new Map<number, OutgoingCall>();
	readonly #window = new CallWindow<OutgoingCall>();
	/**
	 * The calls this host relays upstream on this link, one window per downstream origin's number here (decision "Call
	 * windows only for untrusted links": a relay honours each upstream window); made by an origin's first call.
	 */
	readonly #relayed = new Map<number, CallWindow<QueuedCall<unknown>>>();
	/** The peer's `hello`: its call window (`undefined`: none), once it arrived. */
	#greeted: { readonly calls: number | undefined } | undefined;
	/** The `event` messages consumed since the last event `ack` (one goes in a microtask after the first). */
	#consumed = 0;
	#nextHold = 0;
	#nextCall = 0;

	constructor(link: HostLink) {
		this.#link = link;
	}

	/**
	 * Holds `holder` on this link and returns its new id: its first hold, or a re-hold on a new link; `chain`: the
	 * activation chain it is held for, if any (Q5); `trace`: this hold's carrier, if any.
	 */
	attach(holder: RemoteObject, chain: string[] | undefined, trace: TelemetryCarrier | undefined): number {
		const id = this.#nextHold++;
		this.#entries.set(id, holder);
		const acting = actingFor(this.#link, holder.caller);
		this.#link.send({
			kind: "hold",
			hold: id,
			...holder.request,
			...acting,
			...(chain === undefined ? {} : { chain }),
			...(trace === undefined ? {} : { trace }),
		});
		return id;
	}

	/**
	 * Calls method `method` (an index into the bound variant) on hold `hold` with `args`: left out for a method without
	 * arguments, with byte segments when its argument schema has a `bytes()` leaf, deflated above the threshold except on
	 * the parent link; with the carrier of `context`'s span when its adapter propagates. The result is parsed here. The
	 * caller's cancellation rejects it at once and sends `abort` when it is in flight.
	 */
	call(hold: number, method: number, data: MethodData, args: unknown, context: Context): Promise<unknown> {
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		const payload = takesNoArgs(data) ? undefined : payloadPart(args, data.args.bytes);
		// Up a parent link they travel uncompressed: the parent may have accepted this host as a child, and child links
		// refuse compressed parts (§22).
		const link = this.#link;
		const part =
			payload === undefined ? undefined : link.role === "parent" ? payload.json : link.part(payload.json, context);
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const cancel = (): void => {
			this.#cancel(call);
			reject(signal!.reason);
		};
		const done = (): void => signal?.removeEventListener("abort", cancel);
		const call: OutgoingCall = {
			hold,
			method,
			args: part,
			segments: payload?.segments,
			trace: carrierOf(context.telemetry),
			old: link.host.oldWork.of(context),
			resolve: (value) => {
				done();
				resolve(value);
			},
			reject: (error) => {
				done();
				reject(error);
			},
			id: undefined,
			send: () => this.#send(call),
		};
		signal?.addEventListener("abort", cancel, { once: true });
		this.#window.submit(call);
		return promise;
	}

	/** Hold `hold` was released: the provider is told, its calls fail with `error`. */
	release(hold: number, error: ChordError): void {
		this.#link.send({ kind: "release", hold });
		this.forget(hold, error);
	}

	/** `ref.retry()` on a failed hold, with `hops` left of its budget: the provider is asked for an attempt now. */
	retry(hold: number, hops: number): void {
		this.#link.send({ kind: "retry", hold, hops });
	}

	/** Drops hold `hold` from the tables; its calls, in flight and waiting, fail with `error` and free their slots. */
	forget(hold: number, error: ChordError): void {
		this.#entries.delete(hold);
		this.#failCalls(hold, error);
	}

	/** The peer's `hello` arrived: calls go out within its window (`undefined`: none), relayed ones too. */
	opened(calls: number | undefined): void {
		this.#greeted = { calls };
		this.#window.opened(calls);
		for (const window of this.#relayed.values()) window.opened(calls);
	}

	/**
	 * The window of the calls this host relays on this link for the downstream origin with number `origin` here: they
	 * wait in it while the peer's N calls of that origin are in flight (before its `hello`, all of them).
	 */
	relayWindow<C extends QueuedCall<unknown>>(origin: number): CallWindow<C> {
		let window = this.#relayed.get(origin);
		if (window === undefined) {
			window = new CallWindow();
			if (this.#greeted !== undefined) window.opened(this.#greeted.calls);
			this.#relayed.set(origin, window);
		}
		// One window per origin, made for that origin's relayed calls only.
		return window as CallWindow<C>;
	}

	/** The downstream origin with number `origin` here closed: its relayed calls' window goes (`closed` aborts them). */
	unrelay(origin: number): void {
		this.#relayed.delete(origin);
	}

	/**
	 * Handles one message from the provider: this host's own, or (with an origin) one for a relayed hold. A `bound`,
	 * `state` or `result` with deflated parts to inflate asynchronously returns that promise and is handled after it.
	 */
	message(message: ConsumerMessage): void | Promise<void> {
		if (message.origin !== undefined) {
			this.#link.host.relays.get(message.origin)?.forward(message, this.#link);
			return;
		}
		switch (message.kind) {
			case "bound":
			case "state": {
				const deflated = this.#deflated(message.holds);
				if (deflated !== undefined) return this.#link.inflate(deflated, () => this.message(message));
				if (message.kind === "bound") this.#bound(message.holds);
				else this.#state(message.holds);
				break;
			}
			case "failed":
				this.#failed(message);
				break;
			case "loading":
				this.#loading(message.hold);
				break;
			case "result":
			case "error":
				return this.#reply(message);
			case "gone":
				this.#gone(message);
				break;
			case "event": {
				const deflated = this.#deflatedEvents(message.events);
				if (deflated !== undefined) return this.#link.inflate(deflated, () => this.message(message));
				this.#events(message.events);
				break;
			}
		}
	}

	/** The link closed: calls in flight and waiting reject `unavailable` (never resent, §7); the tables are dropped. */
	closed(): void {
		const error = new ChordError({ code: "unavailable", message: "the link closed" });
		const calls = [...this.#calls.values(), ...this.#window.clear()];
		this.#calls.clear();
		this.#entries.clear();
		// The relays' upstream drops answer their calls (`ProviderSide.upstreamDropped`).
		this.#relayed.clear();
		for (const call of calls) call.reject(error);
	}

	/** Sends a call that got its slot, with the next id. */
	#send(call: OutgoingCall): void {
		const id = this.#nextCall++;
		call.id = id;
		this.#calls.set(id, call);
		const { hold, method, args, segments, trace } = call;
		this.#link.send({
			kind: "call",
			call: id,
			hold,
			method,
			...(args === undefined ? {} : { args }),
			...(segments === undefined ? {} : { segments }),
			trace,
			...(call.old ? { old: true as const } : {}),
		});
	}

	/**
	 * Cancels `call`: a waiting one leaves the window and nothing is sent; one in flight sends `abort` and frees its
	 * slot. Settling the caller is the caller's.
	 */
	#cancel(call: OutgoingCall): void {
		if (call.id === undefined) {
			this.#window.remove(call);
			return;
		}
		if (!this.#calls.delete(call.id)) return;
		this.#link.send({ kind: "abort", call: call.id });
		this.#window.freed();
	}

	/**
	 * The deflated parts of this side's own holds in `entries` that wait for an asynchronous inflate, each with the
	 * link's decoded limit; `undefined` when none does (nothing allocated). Entries of holds this side gave up are not
	 * inflated (Q1).
	 */
	#deflated(entries: readonly (BoundEntry | StateEntry)[]): [DeflatedPart, number][] | undefined {
		const { limits } = this.#link;
		let deflated: [DeflatedPart, number][] | undefined;
		for (const entry of entries) {
			if (!this.#entries.has(entry.hold)) continue;
			for (const member of entry.members) {
				const part = "value" in member ? member.value : member.ops;
				if (!this.#link.inflates(part, limits)) continue;
				deflated ??= [];
				deflated.push([part, limits.decoded]);
			}
		}
		return deflated;
	}

	/**
	 * The deflated values of this side's own holds' events waiting for an asynchronous inflate, each with the link's
	 * decoded limit; `undefined` when none does. Only values something listens to are inflated: those of holds this side
	 * gave up (Q1), of a hold not live or of a member nobody listens to are dropped unopened (an index outside the bound
	 * version throws here, a protocol error).
	 */
	#deflatedEvents(events: readonly WireEvent[]): [DeflatedPart, number][] | undefined {
		const { limits } = this.#link;
		let deflated: [DeflatedPart, number][] | undefined;
		for (const { hold, member, value } of events) {
			if (!this.#link.inflates(value, limits) || this.#entries.get(hold)?.eventNode(member) === undefined) continue;
			deflated ??= [];
			deflated.push([value, limits.decoded]);
		}
		return deflated;
	}

	/**
	 * One `event` message, its parts inflated: each entry goes to its holder (an unknown or released hold drops it), which
	 * hands it to the host's event flush or drops it; then the message is consumed: one event `ack` per inbound turn,
	 * sent after the flush delivered what it consumed (a microtask queued after the flush's).
	 */
	#events(events: readonly WireEvent[]): void {
		for (const { hold, member, at, value } of events) this.#entries.get(hold)?.event(member, at, value, this.#link);
		if (this.#consumed++ > 0) return;
		queueMicrotask(() => {
			const events = this.#consumed;
			this.#consumed = 0;
			this.#link.send({ kind: "ack", events });
		});
	}

	/**
	 * One `bound` message: every entry prepared first (one that does not fit closes the link before anything changed)
	 * and applied in one batch; then the message is acknowledged, and the references go live. An entry with a part past
	 * the link's limits fails only its hold (`too_large/part`); the others apply.
	 */
	#bound(holds: readonly BoundEntry[]): void {
		const adoptions: (() => void)[] = [];
		const bound: RemoteObject[] = [];
		let oversized: [RemoteObject, ChordError][] | undefined;
		for (const entry of holds) {
			const holder = this.#entries.get(entry.hold);
			if (holder === undefined) continue;
			try {
				adoptions.push(holder.prepareBound(entry, this.#link));
			} catch (error) {
				if (!isChordError(error, "too_large")) throw error;
				oversized ??= [];
				oversized.push([holder, error]);
				continue;
			}
			bound.push(holder);
		}
		this.#adopt(adoptions);
		// Acknowledged before the references go live: the calls they send then (their parked ones) follow the `ack`, so
		// the provider decodes them by this binding's indexes, never by a rebinding's previous ones.
		this.#link.send({ kind: "ack" });
		// After the batch: the references go live with every replica of the message in place.
		for (const holder of bound) holder.wentLive();
		for (const [holder, error] of oversized ?? []) holder.tooLarge(error);
	}

	/** One `state` message, as `#bound` does it. */
	#state(holds: readonly StateEntry[]): void {
		const adoptions: (() => void)[] = [];
		let oversized: [RemoteObject, ChordError][] | undefined;
		for (const entry of holds) {
			const holder = this.#entries.get(entry.hold);
			if (holder === undefined) continue;
			try {
				adoptions.push(holder.prepare(entry, this.#link));
			} catch (error) {
				if (!isChordError(error, "too_large")) throw error;
				oversized ??= [];
				oversized.push([holder, error]);
			}
		}
		this.#adopt(adoptions);
		for (const [holder, error] of oversized ?? []) holder.tooLarge(error);
		this.#link.send({ kind: "ack" });
	}

	/** Applies prepared entries in one batch of this host, so no watch or derive sees half a provider commit (W1). */
	#adopt(adoptions: readonly (() => void)[]): void {
		if (adoptions.length === 0) return;
		this.#link.host.batch.commit(() => {
			for (const adopt of adoptions) adopt();
		}, this.#link.context);
	}

	/**
	 * `loading`: the hold's object, or its relay's upstream, starts over; its calls still waiting for a slot reject
	 * `unavailable` (they may name a method of the old variant), its calls in flight wait for their reply (a provider's
	 * `loading` keeps them; a relay's upstream drop answered them before).
	 */
	#loading(hold: number): void {
		const holder = this.#entries.get(hold);
		if (holder === undefined) return;
		const error = new ChordError({ code: "unavailable", message: `hold ${hold}: rebinding` });
		for (const call of this.#window.removeHold(hold)) call.reject(error);
		holder.loading();
	}

	/**
	 * `failed`: its holder fails; its calls still waiting for a slot reject with the cause (a bound hold is unbound by it,
	 * slice 7b; its calls in flight are rejected by the provider).
	 */
	#failed(message: Extract<Message, { readonly kind: "failed" }>): void {
		const holder = this.#entries.get(message.hold);
		if (holder === undefined) return;
		const error = asChordError(errorFromWire(message.cause.error), `hold ${message.hold}`);
		for (const call of this.#window.removeHold(message.hold)) call.reject(error);
		holder.failed(message);
	}

	/**
	 * `gone`: one for a hold this side gave up is ignored (Q1); the holder ends, which forgets its hold here and fails
	 * its calls.
	 */
	#gone(message: Extract<Message, { readonly kind: "gone" }>): void {
		const holder = this.#entries.get(message.hold);
		if (holder === undefined) return;
		holder.lost(asChordError(errorFromWire(message.error), `hold ${message.hold}`));
	}

	/**
	 * A reply: its call settles with the parsed result or the error. A result past the link's limits rejects the call
	 * `too_large/part`. A malformed part rejects the call `unavailable` and throws (a protocol error: the link closes).
	 * A result to inflate asynchronously is inflated first (for a call still waiting), then handled again.
	 */
	#reply(reply: Reply): void | Promise<void> {
		const call = this.#calls.get(reply.call);
		if (call === undefined) return;
		const link = this.#link;
		if (reply.kind === "result" && link.inflates(reply.value, link.limits)) {
			return link.inflate([[reply.value, link.limits.decoded]], () => this.#reply(reply));
		}
		this.#calls.delete(reply.call);
		this.#window.freed();
		try {
			if (reply.kind === "error") call.reject(errorFromWire(reply.error));
			else if (reply.value === undefined) call.resolve(null);
			else call.resolve(parsePayload(link.openPart(reply.value, link.limits, link.context), reply.segments));
		} catch (error) {
			if (isChordError(error, "too_large")) {
				call.reject(error);
				return;
			}
			call.reject(new ChordError({ code: "unavailable", message: `call ${reply.call}: a malformed reply` }));
			throw error;
		}
	}

	/** Fails `hold`'s calls in flight and waiting with `error`; each in-flight one frees its slot. */
	#failCalls(hold: number, error: ChordError): void {
		// Waiting ones first: a freed slot must not send one of them.
		const failed = this.#window.removeHold(hold);
		for (const [id, call] of this.#calls) {
			if (call.hold !== hold) continue;
			this.#calls.delete(id);
			this.#window.freed();
			failed.push(call);
		}
		for (const call of failed) call.reject(error);
	}
}
