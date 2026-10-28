// The consumer side of a link (§7, §22, W1): the holds this host's own remote references sent on it, by this side's
// ids, the calls through them within the peer's call window, and each `bound` and `state` message applied to their
// replicas as one batch, then acknowledged. Messages with an origin answer holds this host relays: they go to that
// origin's provider side. On a host without a compressor, the deflated parts of this host's own holds and calls are
// inflated asynchronously first, and the message is handled once they are.

import type { Context } from "../../context/index.ts";
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
} from "../link/internal.ts";
import { CallWindow } from "./calls.ts";
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
	#nextHold = 0;
	#nextCall = 0;

	constructor(link: HostLink) {
		this.#link = link;
	}

	/**
	 * Holds `holder` on this link and returns its new id: its first hold, or a re-hold on a new link; `chain`: the
	 * activation chain it is held for, if any (Q5).
	 */
	attach(holder: RemoteObject, chain: string[] | undefined): number {
		const id = this.#nextHold++;
		this.#entries.set(id, holder);
		const acting = actingFor(this.#link, holder.caller);
		this.#link.send({
			kind: "hold",
			hold: id,
			...holder.request,
			...acting,
			...(chain === undefined ? {} : { chain }),
		});
		return id;
	}

	/**
	 * Calls method `method` (an index into the bound variant) on hold `hold` with `args`: left out for a method without
	 * arguments, with byte segments when its argument schema has a `bytes()` leaf, deflated above the threshold except on
	 * the parent link. The result is parsed here. The caller's cancellation rejects it at once and sends `abort` when it
	 * is in flight.
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

	/** `ref.retry()` on a failed hold: the provider is asked for an attempt now. */
	retry(hold: number): void {
		this.#link.send({ kind: "retry", hold });
	}

	/** Drops hold `hold` from the tables; its calls, in flight and waiting, fail with `error` and free their slots. */
	forget(hold: number, error: ChordError): void {
		this.#entries.delete(hold);
		this.#failCalls(hold, error);
	}

	/** The peer's `hello` arrived: calls go out within its window. */
	opened(calls: number): void {
		this.#window.opened(calls);
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
				this.#entries.get(message.hold)?.failed(message);
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
		}
	}

	/** The link closed: calls in flight and waiting reject `unavailable` (never resent, §7); the tables are dropped. */
	closed(): void {
		const error = new ChordError({ code: "unavailable", message: "the link closed" });
		const calls = [...this.#calls.values(), ...this.#window.clear()];
		this.#calls.clear();
		this.#entries.clear();
		for (const call of calls) call.reject(error);
	}

	/** Sends a call that got its slot, with the next id. */
	#send(call: OutgoingCall): void {
		const id = this.#nextCall++;
		call.id = id;
		this.#calls.set(id, call);
		const { hold, method, args, segments } = call;
		this.#link.send({
			kind: "call",
			call: id,
			hold,
			method,
			...(args === undefined ? {} : { args }),
			...(segments === undefined ? {} : { segments }),
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
	 * One `bound` message: every entry prepared first (one that does not fit closes the link before anything changed)
	 * and applied in one batch; then the references go live, and the message is acknowledged. An entry with a part past
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
		// After the batch: the references go live with every replica of the message in place.
		for (const holder of bound) holder.wentLive();
		for (const [holder, error] of oversized ?? []) holder.tooLarge(error);
		this.#link.send({ kind: "ack" });
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
	 * `unavailable` (they may name a method of the old variant).
	 */
	#loading(hold: number): void {
		const holder = this.#entries.get(hold);
		if (holder === undefined) return;
		const error = new ChordError({ code: "unavailable", message: `hold ${hold}: rebinding` });
		for (const call of this.#window.removeHold(hold)) call.reject(error);
		holder.loading();
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
