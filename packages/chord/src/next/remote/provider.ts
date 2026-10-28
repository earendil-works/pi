// The provider side of one origin on a link (§3, §22, W1; decision "Relay flow control per origin"): the holds the
// peer sent for that origin, served here or relayed, by their ids; the calls on them, at most this side's N at once;
// and the window: at most K unacknowledged `bound` and `state` messages of this host's own, with what waits meanwhile,
// and the sender of every message in flight, so each `ack` reaches the host that sent its message.

import { type Context, withAbortSignal } from "../../context/index.ts";
import { ChordError, isChordError, type Principal } from "../data/index.ts";
import type { Caller } from "../host/internal.ts";
import {
	type BoundEntry,
	type ConsumerMessage,
	DeflatedPart,
	type Message,
	type OriginMessage,
	oversized,
	type ProviderMessage,
	parsePayload,
	payloadPart,
	type StateEntry,
	wireError,
} from "../link/internal.ts";
import { Hold } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { RelayedHold } from "./relay.ts";

/**
 * A call being handled: on a hold served here, with whether its result carries byte segments and the abort of its
 * handler's context; or relayed, its reply forwarded from upstream.
 */
type RunningCall =
	| { readonly kind: "served"; readonly hold: Hold; readonly bytes: boolean; readonly abort: AbortController }
	| { readonly kind: "relayed"; readonly hold: RelayedHold };

/** Who sent a `bound` or `state` message in flight: this host, or the upstream link a relay forwarded it from. */
type Sender = "local" | HostLink;

/** A relaying origin: its number on upstream links, and the open upstream links it relayed holds to. */
type Relay = { readonly origin: number; readonly links: Set<HostLink> };

/** At most this many of this host's own `bound` and `state` messages unacknowledged per origin. */
const WINDOW = 2;

/**
 * The provider side of one origin on a link. Ids are the origin's; a message naming an id this side does not know is
 * ignored (Q1), one reusing a live id is a protocol error, and so are more concurrent calls than this side announced.
 * This host's own `bound` and `state` messages go through the window: locally served holds wait while it is full
 * (their ops in their members' pending queues, their bindings for the next slot). A relay forwards upstream messages
 * at once (each upstream host keeps its own window for the origin it sees), so a slow consumer stalls only its origin.
 */
export class ProviderSide {
	readonly link: HostLink;
	/** Whose work this side serves: 0 for the peer's own, a relay's number for one of its downstream links. */
	readonly origin: number;
	readonly #calls = new Map<number, RunningCall>();
	readonly #entries = new Map<number, Hold | RelayedHold>();
	readonly #limit: number;
	/** The sender of each `bound` and `state` message in flight, in order: the consumer acknowledges in order. */
	readonly #sent: Sender[] = [];
	/** This host's own messages in flight. */
	#inFlight = 0;
	/** The holds the current batch touched, in order; its flush sends or queues them. */
	#touched: Hold[] = [];
	/** Holds whose ops wait in their pending queues for a slot. */
	readonly #waiting = new Set<Hold>();
	/** Holds waiting for a slot to send their first binding. */
	readonly #binding = new Set<Hold>();
	/** The waiting bindings take the next slot: the last one went to waiting state while they waited. */
	#bindingTurn = false;
	/** Set once a hold of this origin is relayed. */
	#relay: Relay | undefined;

	constructor(link: HostLink, origin: number, limit: number) {
		this.link = link;
		this.origin = origin;
		this.#limit = limit;
	}

	/** Handles one message of this origin; a call whose arguments wait for an asynchronous inflate returns its promise. */
	message(message: ProviderMessage): void | Promise<void> {
		switch (message.kind) {
			case "hold":
				this.#hold(message);
				break;
			case "release":
				this.#release(message.hold);
				break;
			case "call":
				return this.#call(message);
			case "abort":
				this.#abort(message.call);
				break;
			case "retry":
				this.#entries.get(message.hold)?.retry();
				break;
			case "ack":
				this.#ack();
				break;
		}
	}

	/**
	 * The link closed, or the origin did (`closed`): every hold is released (relayed ones by one `closed` to each
	 * upstream link) and every call aborted.
	 */
	closed(): void {
		const closing = this.link.host.closing;
		const entries = [...this.#entries.values()];
		this.#entries.clear();
		const closed = new ChordError({ code: "unavailable", message: "the link closed" });
		for (const call of this.#calls.values()) if (call.kind === "served") call.abort.abort(closed);
		this.#calls.clear();
		// While the host closes, it ends its objects itself.
		for (const entry of entries) {
			if (entry.kind === "served" && !closing) entry.release();
			else entry.drop();
		}
		// A batch flushing later finds nothing of this side.
		this.#touched = [];
		const relay = this.#relay;
		if (relay === undefined) return;
		this.link.host.relays.delete(relay.origin);
		for (const link of relay.links) link.send({ kind: "closed", origin: relay.origin });
	}

	/** Sends `message` on the link with this origin. */
	send(message: OriginMessage): void {
		this.link.send(this.origin === 0 ? message : { ...message, origin: this.origin });
	}

	/**
	 * Ends with `error` every hold of this origin that acts for a principal `revoked` names and still waits: for `load`
	 * (served here), or for its route's link (relayed).
	 */
	revokeWaiting(revoked: (principal: Principal) => boolean, error: ChordError): void {
		for (const hold of [...this.#entries.values()]) {
			// A hold arriving on a link acts for a principal: the link's, or one its parent named.
			if (!hold.waiting || !revoked(hold.caller.principal!)) continue;
			if (hold.kind === "served") hold.end(error);
			else hold.revoked(error);
		}
	}

	/** A pending hold turned out to be relayed: it takes the hold's place in the table. */
	relayed(hold: RelayedHold): void {
		this.#entries.set(hold.id, hold);
	}

	/** This origin's number on upstream links (one per host, never reused), with `link` as one it relays to. */
	relayTo(link: HostLink): number {
		let relay = this.#relay;
		if (relay === undefined) {
			relay = { origin: this.link.host.relayOrigin(this), links: new Set() };
			this.#relay = relay;
		}
		relay.links.add(link);
		return relay.origin;
	}

	/**
	 * A message from upstream link `from` for this origin's relayed holds, forwarded with this origin: `bound` and
	 * `state` join the window's senders (their `ack` goes back to `from`), a reply ends its call, `gone` forgets its
	 * hold. A link answers only for what was relayed over it: an entry, a notice or a reply naming a hold (or a call)
	 * this origin did not relay over `from` is dropped (Q1); a `bound` or `state` left without entries is acknowledged
	 * to `from` at once. Parts travel unchecked and unparsed: the end that parses a part checks it against its own
	 * link's limits.
	 */
	forward(message: ConsumerMessage, from: HostLink): void {
		const relay = this.#relay;
		if (relay === undefined || !relay.links.has(from)) return;
		const { origin: _, ...forwarded } = message;
		switch (forwarded.kind) {
			case "bound":
			case "state": {
				const holds = this.#relayedOver<BoundEntry | StateEntry>(forwarded.holds, from);
				if (holds.length === 0) {
					from.send({ kind: "ack", origin: relay.origin });
					return;
				}
				this.#sent.push(from);
				// The entries of the message's own kind.
				this.send(holds === forwarded.holds ? forwarded : ({ ...forwarded, holds } as typeof forwarded));
				return;
			}
			case "result":
			case "error": {
				const call = this.#calls.get(forwarded.call);
				if (call?.kind === "relayed" && call.hold.heldOn(from)) this.reply(forwarded.call, forwarded);
				return;
			}
			case "gone": {
				const hold = this.#relayedHold(forwarded.hold, from);
				if (hold === undefined) return;
				hold.lost();
				this.send(forwarded);
				return;
			}
			default:
				if (this.#relayedHold(forwarded.hold, from) !== undefined) this.send(forwarded);
		}
	}

	/** An upstream link closed: nothing more is relayed to it, nor accepted from it. */
	unlinked(link: HostLink): void {
		this.#relay?.links.delete(link);
	}

	/**
	 * The upstream link of relayed hold `hold` dropped with `error`: its calls in flight fail, the hold goes loading
	 * downstream, and its path's next link holds it again.
	 */
	upstreamDropped(hold: RelayedHold, error: ChordError): void {
		for (const [id, call] of this.#calls) {
			if (call.hold === hold) this.reply(id, { kind: "error", call: id, error: wireError(error) });
		}
		this.send({ kind: "loading", hold: hold.id });
	}

	/**
	 * Forgets a hold (released, refused or gone) and every call on it; local calls are aborted with `error` (its
	 * object's end for a gone hold, `released` otherwise).
	 */
	forget(hold: Hold | RelayedHold, error?: ChordError): void {
		if (this.#entries.get(hold.id) === hold) this.#entries.delete(hold.id);
		const reason = error ?? new ChordError({ code: "released", message: `hold ${hold.id}: released` });
		for (const [id, call] of this.#calls) {
			if (call.hold !== hold) continue;
			this.#calls.delete(id);
			if (call.kind === "served") call.abort.abort(reason);
		}
		if (hold.kind === "served") this.unbind(hold);
	}

	/** A call ended with `reply` (a result or an error): its slot is free; nothing is sent for one already gone. */
	reply(id: number, reply: Extract<OriginMessage, { readonly kind: "result" | "error" }>): void {
		if (!this.#calls.delete(id)) return;
		this.send(reply);
	}

	/** A hold's object is live: its `bound` goes now when a slot is free, else with the next free slot's bindings. */
	bind(hold: Hold, context: Context): void {
		if (this.#free) {
			this.#sendOwn({ kind: "bound", holds: [hold.boundEntry(context)] });
		} else {
			this.#binding.add(hold);
		}
	}

	/** A hold stopped waiting for a slot: it was forgotten. */
	unbind(hold: Hold): void {
		this.#waiting.delete(hold);
		this.#binding.delete(hold);
	}

	/** A hold's members changed in the current batch; its flush sends or queues it. */
	touched(hold: Hold): void {
		if (this.#touched.length === 0) this.link.host.batch.flushing((context) => this.#flush(context));
		this.#touched.push(hold);
	}

	/**
	 * `entries` whose holds this origin relayed over `from`, in one pass: the same array when all are, else a copy made
	 * at the first one that is not.
	 */
	#relayedOver<E extends { readonly hold: number }>(entries: readonly E[], from: HostLink): readonly E[] {
		let kept: E[] | undefined;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			const relayed = this.#relayedHold(entry.hold, from) !== undefined;
			if (kept !== undefined) {
				if (relayed) kept.push(entry);
			} else if (!relayed) {
				kept = entries.slice(0, i);
			}
		}
		return kept ?? entries;
	}

	/** The hold `id` of this origin when it is relayed over `from`. */
	#relayedHold(id: number, from: HostLink): RelayedHold | undefined {
		const hold = this.#entries.get(id);
		return hold?.kind === "relayed" && hold.heldOn(from) ? hold : undefined;
	}

	/**
	 * A hold message: a protocol error for a live id or compressed params (params are never compressed), otherwise
	 * admitted once `load` resolved (`Hold.start`). Its activation chain is kept only from a trusted link (Q5); its
	 * decoded limit is the link's, or the smaller one a parent stamped (Q2), and travels with it when it is relayed.
	 */
	#hold(message: Extract<Message, { readonly kind: "hold" }>): void {
		if (this.#entries.has(message.hold)) throw new Error(`hold ${message.hold}: the id is in use`);
		if (message.params instanceof DeflatedPart) throw new Error(`hold ${message.hold}: compressed params`);
		// Whom it acts for is decided here once (`#caller`), never passed on: a relay names it only on a route link.
		const {
			kind: _kind,
			origin: _origin,
			hold: id,
			principal: _principal,
			incarnation: _incarnation,
			chain,
			limit: stamped,
			...fields
		} = message;
		const { link } = this;
		const limit = Math.min(link.limits.decoded, (link.role === "parent" ? stamped : undefined) ?? Infinity);
		const request = {
			...fields,
			...(chain !== undefined && link.trusted ? { chain } : {}),
			...(limit === Infinity ? {} : { limit }),
		};
		const limits = limit === link.limits.decoded ? link.limits : { part: link.limits.part, decoded: limit };
		const hold = new Hold(id, this, this.#caller(message), limits);
		this.#entries.set(id, hold);
		void hold.start(request);
	}

	/**
	 * Whom a hold acts for: on a parent link the hold's own principal and incarnation when it names them, everywhere
	 * else the link's principal and the peer's incarnation (a child cannot claim to be someone else).
	 */
	#caller(message: Extract<Message, { readonly kind: "hold" }>): Caller {
		const { link } = this;
		if (link.role !== "parent") return { principal: link.principal, incarnation: link.peer };
		// The message schema checked a principal's shape on an untrusted link; a trusted parent is believed.
		const principal = (message.principal as Caller["principal"]) ?? link.principal;
		return { principal, incarnation: message.incarnation ?? link.peer };
	}

	#release(id: number): void {
		const hold = this.#entries.get(id);
		if (hold === undefined) return;
		this.forget(hold);
		hold.release();
	}

	/**
	 * A call: one on a hold this side does not know is ignored (Q1), more than this side's N at once and compressed
	 * arguments from a child (clients never compress) are protocol errors. On a relayed hold it is forwarded, its
	 * arguments checked against this link's part limit first (the bytes are here). On a served hold that is not bound
	 * yet it is refused `not_ready`; its method is an index into the bound variant (one outside it is a protocol error)
	 * and its arguments are opened and parsed here within the hold's limits (past one the call fails `too_large/part`; a
	 * malformed part is a protocol error), absent ones `null`. Arguments this host must inflate asynchronously are
	 * inflated first, then the call is handled again.
	 */
	#call(message: Extract<Message, { readonly kind: "call" }>): void | Promise<void> {
		if (this.#calls.has(message.call)) throw new Error(`call ${message.call}: the id is in use`);
		const hold = this.#entries.get(message.hold);
		if (hold === undefined) return;
		if (this.#calls.size >= this.#limit) throw new Error(`call ${message.call}: more than ${this.#limit} calls`);
		const { args: part, segments } = message;
		if (part instanceof DeflatedPart && this.link.role === "child") {
			throw new Error(`call ${message.call}: compressed arguments from a child`);
		}
		if (hold.kind === "relayed") {
			const error = part === undefined ? undefined : oversized(part, this.link.limits.part);
			if (error !== undefined) {
				this.#refuse(message.call, error);
				return;
			}
			this.#calls.set(message.call, { kind: "relayed", hold });
			hold.call(message);
			return;
		}
		if (!hold.bound) {
			this.#refuse(message.call, new ChordError({ code: "not_ready", message: `hold ${hold.id}: not bound yet` }));
			return;
		}
		const method = hold.method(message.method);
		if (this.link.inflates(part, hold.limits)) {
			return this.link.inflate([[part, hold.limits.decoded]], () => this.#call(message));
		}
		let json: string | Uint8Array | undefined;
		try {
			json = part === undefined ? undefined : this.link.openPart(part, hold.limits, this.link.context);
		} catch (error) {
			if (!isChordError(error, "too_large")) throw error;
			this.#refuse(message.call, error);
			return;
		}
		const args = json === undefined ? null : parsePayload(json, segments);
		const call = { kind: "served", hold, bytes: method.resultBytes, abort: new AbortController() } as const;
		this.#calls.set(message.call, call);
		void this.#run(message.call, call, method.name, args);
	}

	/**
	 * Runs a call and sends its result (absent when `null`) or error, unless it was aborted, released or gone
	 * meanwhile. A result that cannot be encoded is sent as its error.
	 */
	async #run(
		id: number,
		call: Extract<RunningCall, { readonly kind: "served" }>,
		method: string,
		args: unknown,
	): Promise<void> {
		let reply: Extract<OriginMessage, { readonly kind: "result" | "error" }>;
		try {
			// A link's context has no abort signal, so this is the call's own signal: no `AbortSignal.any` per call.
			const result = await call.hold.call(method, args, withAbortSignal(call.abort.signal, this.link.context));
			// Results are not validated: they are the provider's.
			reply =
				result === null || result === undefined
					? { kind: "result", call: id }
					: this.#result(id, result, call.bytes, this.link.context);
		} catch (error) {
			reply = { kind: "error", call: id, error: wireError(error) };
		}
		this.reply(id, reply);
	}

	/** Answers call `id` with `error` before it was admitted: it took no slot. */
	#refuse(id: number, error: ChordError): void {
		this.send({ kind: "error", call: id, error: wireError(error) });
	}

	#abort(id: number): void {
		const call = this.#calls.get(id);
		if (call === undefined) return;
		this.#calls.delete(id);
		if (call.kind === "relayed") call.hold.abort(id);
		else call.abort.abort(new ChordError({ code: "aborted", message: `call ${id}: aborted by its caller` }));
	}

	/**
	 * An `ack` answers the oldest message in flight: this host's own frees a slot, a relayed one is acknowledged to its
	 * upstream link (closed meanwhile: nothing to do). An ack crossing nothing in flight is ignored.
	 */
	#ack(): void {
		const sender = this.#sent.shift();
		if (sender === undefined) return;
		if (sender !== "local") {
			// A relayed message implies the relay's number.
			sender.send({ kind: "ack", origin: this.#relay!.origin });
			return;
		}
		this.#inFlight--;
		this.#slotFreed();
	}

	/**
	 * The end of a batch: while a slot is free and nothing waits, one `state` message with an entry per touched hold;
	 * otherwise each touched hold's ops join its pending queues until a slot frees.
	 */
	#flush(context: Context): void {
		const holds = this.#touched;
		// The side closed during the batch: nothing is sent.
		if (holds.length === 0) return;
		this.#touched = [];
		if (this.#free) {
			this.#sendOwn({ kind: "state", holds: holds.map((hold) => hold.entry(context)) });
			return;
		}
		// Only a bound hold is touched, and a bound hold never waits for its binding.
		for (const hold of holds) {
			hold.queue();
			this.#waiting.add(hold);
		}
	}

	/** Whether this host's next message goes out now: a slot is free and nothing waits for one. */
	get #free(): boolean {
		return this.#binding.size === 0 && this.#waiting.size === 0 && this.#inFlight < WINDOW;
	}

	/**
	 * A slot may be free: while there is room, the waiting state goes out as one message and the waiting bindings as
	 * one `bound`, taking turns when both wait (state first), so neither a hold that keeps changing nor a stream of new
	 * holds starves the other.
	 */
	#slotFreed(): void {
		const context = this.link.context;
		while (this.#inFlight < WINDOW) {
			if (this.#binding.size > 0 && (this.#waiting.size === 0 || this.#bindingTurn)) {
				const holds = [...this.#binding];
				this.#binding.clear();
				this.#bindingTurn = false;
				// Every snapshot in one synchronous step: the binding shows all of them at one moment.
				this.#sendOwn({ kind: "bound", holds: holds.map((hold) => hold.boundEntry(context)) });
			} else if (this.#waiting.size > 0) {
				const holds = [...this.#waiting];
				this.#waiting.clear();
				this.#bindingTurn = this.#binding.size > 0;
				this.#sendOwn({ kind: "state", holds: holds.map((hold) => hold.pendingEntry(context)) });
			} else {
				return;
			}
		}
	}

	/**
	 * A call's result message, its part deflated above the threshold when this host compresses; with byte segments when
	 * its method's result schema has a `bytes()` leaf.
	 */
	#result(
		id: number,
		result: unknown,
		bytes: boolean,
		context: Context,
	): Extract<OriginMessage, { readonly kind: "result" }> {
		const { json, segments } = payloadPart(result, bytes);
		const value = this.link.part(json, context);
		return { kind: "result", call: id, value, ...(segments === undefined ? {} : { segments }) };
	}

	/** Sends one of this host's own `bound` or `state` messages, taking a slot. */
	#sendOwn(message: Extract<OriginMessage, { readonly kind: "bound" | "state" }>): void {
		this.#inFlight++;
		this.#sent.push("local");
		this.send(message);
	}
}
