// The provider side of one origin on a link (§3, §22, W1; decision "Relay flow control per origin"): the holds the
// peer sent for that origin, served here or relayed, by their ids; the calls on them, at most this side's N at once
// (none on a trusted link), relayed ones waiting for their upstream link's window; the window: at most K
// unacknowledged `bound` and `state` messages of this host's own, with what waits meanwhile (a call's answer sends the
// waiting state first, past the window), and the sender of every message in flight, so each `ack` reaches the host
// that sent its message; and events (decision "Events: fire-and-forget members"), with a window of their own: at most `eventWindow`
// of this host's `event` messages unacknowledged (a full window drops a flush's events) and a FIFO of tickets naming
// each message's sender. A served call's method runs under the call's carrier (slice 9).

import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { type Context, withAbortSignal } from "../context/index.ts";
import { ChordError, isChordError, type Principal } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import { asRemoteOldWork, type Caller, type EventEntry, type EventFlush, type EventSender } from "../host/internal.ts";
import {
	type BoundEntry,
	type ConsumerMessage,
	DeflatedPart,
	errorFromWire,
	jsonPart,
	type Message,
	type OriginMessage,
	oversized,
	type ProviderMessage,
	parsePayload,
	payloadPart,
	type StateEntry,
	type WireEvent,
	wireError,
} from "../link/internal.ts";
import { parentOf } from "../telemetry.ts";
import { Hold } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import { endAll, RelayedCall, type RelayedHold } from "./relay.ts";

/**
 * A call being handled: on a hold served here, with whether its result carries byte segments and the abort of its
 * handler's context; or relayed, waiting for or forwarded to its upstream link, its reply forwarded from there.
 */
type RunningCall =
	| { readonly kind: "served"; readonly hold: Hold; readonly bytes: boolean; readonly abort: AbortController }
	| RelayedCall;

/**
 * Who sent a `bound` or `state` message in flight: this host, the upstream link a relay forwarded a `state` from, or
 * for a relayed `bound` that link and the holds it bound (their queued calls go before its `ack` does: `#ack`).
 */
type Sender =
	| { readonly kind: "local" }
	| { readonly kind: "state"; readonly from: HostLink }
	| { readonly kind: "bound"; readonly from: HostLink; readonly holds: readonly number[] };

/** Who sent an `event` message in flight (its ticket): this host, or the upstream link a relay forwarded it from. */
type EventTicket = { readonly kind: "local" } | { readonly kind: "relayed"; readonly from: HostLink };

/** This host's own message in flight, a sender and a ticket alike: shared. */
const LOCAL = { kind: "local" } as const;

/** A relaying origin: its number on upstream links, and the open upstream links it relayed holds to. */
type Relay = { readonly origin: number; readonly links: Set<HostLink> };

/**
 * At most this many of this host's own `bound` and `state` messages unacknowledged per origin; past it only the waiting
 * state a call's answer sends first.
 */
const WINDOW = 2;

/**
 * The provider side of one origin on a link. Ids are the origin's; a message naming an id this side does not know is
 * ignored (Q1), one reusing a live id is a protocol error, and so are more concurrent calls than this side announced.
 * This host's own `bound` and `state` messages go through the window: locally served holds wait while it is full
 * (their ops in their members' pending queues, their bindings for the next slot); a call's answer, its own or a
 * relayed one, sends the waiting state first. A relay forwards upstream messages at once (each upstream host keeps its
 * own window for the origin it sees), so a slow consumer stalls only its origin.
 */
export class ProviderSide implements EventSender {
	readonly link: HostLink;
	/** Whose work this side serves: 0 for the peer's own, a relay's number for one of its downstream links. */
	readonly origin: number;
	readonly #calls = new Map<number, RunningCall>();
	readonly #entries = new Map<number, Hold | RelayedHold>();
	/** The call window this side announced (`undefined`: none, on a trusted link). */
	readonly #limit: number | undefined;
	/** The sender of each `bound` and `state` message in flight, in order: the consumer acknowledges in order. */
	readonly #sent: Sender[] = [];
	/** This host's own messages in flight. */
	#inFlight = 0;
	/** How many of this host's own `bound` and `state` messages it sent, and how many its consumer acknowledged. */
	#ownSent = 0;
	#ownAcked = 0;
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
	/** When state began waiting for a slot (`performance.now()`), while some waits: `chord.backpressure.wait`. */
	#waitingSince: number | undefined;
	/** The event flush's entries for this origin's holds served here, until it sends them (`sendEvents`). */
	#events: WireEvent[] = [];
	/** The sender of each `event` message of this origin in flight, in order: an event `ack` consumes the first ones. */
	readonly #tickets: EventTicket[] = [];
	/** This host's own `event` messages in flight: at most the host's `eventWindow`. */
	#eventsInFlight = 0;

	constructor(link: HostLink, origin: number, limit: number | undefined) {
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
				this.#settle();
				break;
			case "call":
				return this.#call(message);
			case "abort":
				this.#abort(message.call);
				this.#settle();
				break;
			case "retry":
				this.#entries.get(message.hold)?.retry(message);
				break;
			case "ack":
				if (message.events === undefined) this.#ack();
				else this.#eventAck(message.events);
				this.#settle();
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
		const relayed: RelayedCall[] = [];
		for (const call of this.#calls.values()) {
			if (call.kind === "served") call.abort.abort(closed);
			else relayed.push(call);
		}
		this.#calls.clear();
		// Relayed calls end with their upstream windows (`unrelay` below): `closed` aborts them upstream.
		endAll(relayed);
		// While the host closes, it ends its objects itself.
		for (const entry of entries) {
			if (entry.kind === "served" && !closing) entry.release();
			else entry.drop();
		}
		// A batch or an event flush running later finds nothing of this side.
		this.#touched = [];
		this.#events = [];
		const relay = this.#relay;
		if (relay === undefined) return;
		this.link.host.relays.delete(relay.origin);
		for (const link of relay.links) {
			link.send({ kind: "closed", origin: relay.origin });
			link.consumer.unrelay(relay.origin);
		}
	}

	/** Sends `message` on the link with this origin. */
	send(message: OriginMessage): void {
		this.link.send(this.origin === 0 ? message : { ...message, origin: this.origin });
	}

	/**
	 * Ends with `error` every hold of this origin that acts for a principal `revoked` names and holds nothing: served
	 * here but unbound (before the publication, refused), or relayed and waiting for its route's link.
	 */
	revokeUnbound(revoked: (principal: Principal) => boolean, error: ChordError): void {
		for (const hold of [...this.#entries.values()]) {
			// A hold arriving on a link acts for a principal: the link's, or one its parent named.
			if (!revoked(hold.caller.principal!)) continue;
			if (hold.kind === "served" && hold.unbound) hold.end(error);
			else if (hold.kind === "relayed" && hold.waiting) hold.revoked(error);
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
	 * `state` join the window's senders (their `ack` goes back to `from`), a reply ends its call (after this host's own
	 * waiting state: `reply`), `gone` forgets its hold. A hold's calls still waiting for the upstream window are rejected
	 * before its `loading` (`unavailable`: they carry the old variant's method indexes; its forwarded ones are kept),
	 * `failed` or `gone` (with that cause) is forwarded. A link answers only for what was relayed over it: an entry, a
	 * notice or a reply naming a hold (or a call) this origin did not relay over `from` is dropped (Q1); a `bound` or
	 * `state` left without entries is acknowledged to `from` at once. Parts travel unchecked and unparsed: the end that
	 * parses a part checks it against its own link's limits.
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
				const sender: Sender =
					forwarded.kind === "bound"
						? { kind: "bound", from, holds: holds.map(({ hold }) => hold) }
						: { kind: "state", from };
				this.#sent.push(sender);
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
			case "event": {
				// Forwarded at once, never dropped for congestion and never acknowledged here, also with no entry left: the
				// downstream's acks, in order, return each ticket to its sender.
				const events = this.#relayedOver(forwarded.events, from);
				this.#tickets.push({ kind: "relayed", from });
				// The entries of the message's own kind.
				this.send(events === forwarded.events ? forwarded : ({ ...forwarded, events } as typeof forwarded));
				return;
			}
			case "gone": {
				const hold = this.#relayedHold(forwarded.hold, from);
				if (hold === undefined) return;
				this.#rejectRelayed(hold, asChordError(errorFromWire(forwarded.error), `hold ${hold.id}`), "queued");
				hold.lost();
				this.send(forwarded);
				return;
			}
			case "failed":
			case "loading": {
				const hold = this.#relayedHold(forwarded.hold, from);
				if (hold === undefined) return;
				const error =
					forwarded.kind === "failed"
						? asChordError(errorFromWire(forwarded.cause.error), `hold ${hold.id}`)
						: new ChordError({ code: "unavailable", message: `hold ${hold.id}: rebinding` });
				this.#rejectRelayed(hold, error, "queued");
				this.send(forwarded);
			}
		}
	}

	/** An upstream link closed: nothing more is relayed to it, nor accepted from it. */
	unlinked(link: HostLink): void {
		this.#relay?.links.delete(link);
	}

	/**
	 * The upstream link of relayed hold `hold` dropped with `error`: its calls fail, in flight or still waiting for the
	 * upstream window (never resent), the hold goes loading downstream, and its path's next link holds it again.
	 */
	upstreamDropped(hold: RelayedHold, error: ChordError): void {
		this.#rejectRelayed(hold, error, "all");
		this.send({ kind: "loading", hold: hold.id });
	}

	/**
	 * Answers `error` to the calls of relayed hold `hold`: those still waiting for the upstream window (`queued`), or all
	 * of them. The waiting ones leave their window before any slot is counted free, so a freed slot never forwards a call
	 * being rejected.
	 */
	#rejectRelayed(hold: RelayedHold, error: ChordError, which: "queued" | "all"): void {
		const rejected: number[] = [];
		for (const [id, call] of this.#calls) {
			if (call.hold !== hold || call.kind !== "relayed") continue;
			if (call.unqueue() || which === "all") rejected.push(id);
		}
		const answer = wireError(error);
		for (const id of rejected) this.reply(id, { kind: "error", call: id, error: answer });
	}

	/**
	 * Forgets a hold (released, refused or gone) and every call on it; local calls are aborted with `error` (its
	 * object's end for a gone hold, `released` otherwise).
	 */
	forget(hold: Hold | RelayedHold, error?: ChordError): void {
		if (this.#entries.get(hold.id) === hold) this.#entries.delete(hold.id);
		const reason = error ?? new ChordError({ code: "released", message: `hold ${hold.id}: released` });
		let relayed: RelayedCall[] | undefined;
		for (const [id, call] of this.#calls) {
			if (call.hold !== hold) continue;
			this.#calls.delete(id);
			if (call.kind === "served") call.abort.abort(reason);
			else {
				relayed ??= [];
				relayed.push(call);
			}
		}
		// The forwarded ones end upstream with the hold (its `release`, sent before this, or the upstream's `gone`).
		if (relayed !== undefined) endAll(relayed);
		if (hold.kind === "served") this.unbind(hold);
		this.#settle();
	}

	/**
	 * A call ended with `reply` (a result or an error, its own or forwarded from upstream): its slot is free; nothing is
	 * sent for one already gone. The state waiting for a slot goes first, past the window if it is full (decision "A
	 * call's answer follows its state"): when the call settles at the consumer, every change this host committed before
	 * answering is applied there.
	 */
	reply(id: number, reply: Extract<OriginMessage, { readonly kind: "result" | "error" }>): void {
		const call = this.#calls.get(id);
		if (call === undefined) return;
		this.#calls.delete(id);
		if (call.kind === "relayed") call.end(reply);
		// At most one extra message per answer, acknowledged before the call its answer frees a slot for (one direction keeps
		// its order): running calls and messages past the window stay within this side's N together.
		if (this.#waiting.size > 0) this.#sendWaiting(this.link.context);
		this.send(reply);
		this.#settle();
	}

	/**
	 * Drops this side from its link once it holds nothing: no holds, no calls, no state and no event messages in flight.
	 * Its origin's next hold makes a new one (origins are never reused), so a long-lived link keeps records only for live
	 * work.
	 */
	#settle(): void {
		if (this.#entries.size === 0 && this.#calls.size === 0 && this.#sent.length === 0 && this.#tickets.length === 0) {
			this.link.drop(this);
		}
	}

	/**
	 * An event flush's entry for served hold `hold`'s event member `member` (an index into its bound variant's). While
	 * this host's event window is full for this origin it is dropped as visited (counted), before anything is encoded:
	 * nothing waits for a slow consumer, and no value is encoded only to be dropped (the window cannot change during a
	 * flush: acks arrive in other turns, and this side sends one message per flush). Otherwise it is queued for this
	 * flush's message of this origin, its value encoded once for every hold and link of the host (`part`).
	 */
	queueEvent(hold: number, member: number, entry: EventEntry, flush: EventFlush): void {
		const { metrics, eventWindow } = this.link.host;
		if (this.#eventsInFlight >= eventWindow) {
			metrics.counter("chord.events.dropped").add(1, { reason: "window" });
			return;
		}
		if (this.#events.length === 0) flush.sending(this);
		if (entry.part === undefined) {
			entry.part = this.link.part(jsonPart(entry.value), this.link.context);
			metrics.counter("chord.events.encodes").add(1);
		}
		this.#events.push({ hold, member, at: entry.at, value: entry.part });
	}

	/** The event flush visited every entry: this origin's admitted entries go as one `event` message, taking a slot. */
	sendEvents(): void {
		const events = this.#events;
		this.#events = [];
		// The side closed during the flush.
		if (events.length === 0) return;
		this.#eventsInFlight++;
		this.#tickets.push(LOCAL);
		this.link.host.metrics.counter("chord.events.sent").add(events.length);
		this.send({ kind: "event", events });
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
		// Nothing waits any more: no wait to record.
		if (this.#waiting.size === 0) this.#waitingSince = undefined;
	}

	/**
	 * A served hold left its object's binding with `error` (a failure, a removal or a version no longer bound; slice 7b
	 * §6, model §5): as `unbind`, and its calls in flight rejected with `error` (each slot freed once). A hold unbinding
	 * with `loading` keeps them (`unbind` alone).
	 */
	unbound(hold: Hold, error: ChordError): void {
		this.unbind(hold);
		for (const [id, call] of this.#calls) {
			if (call.hold !== hold) continue;
			if (call.kind === "served") call.abort.abort(error);
			this.reply(id, { kind: "error", call: id, error: wireError(error) });
		}
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
	 * admitted (`Hold.start`, placed once the host published). Its activation chain is kept only from a trusted link (Q5); its
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
		hold.start(request);
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

	/**
	 * A `release`: the hold is forgotten and released. A relayed one is released upstream first: forgetting it frees its
	 * forwarded calls' slots in the upstream window, and a call of another hold that takes one must reach the upstream
	 * after this release, which ends the forwarded ones there (else the upstream counts one call too many).
	 */
	#release(id: number): void {
		const hold = this.#entries.get(id);
		if (hold === undefined) return;
		if (hold.kind === "relayed") {
			hold.release();
			this.forget(hold);
			return;
		}
		this.forget(hold);
		hold.release();
	}

	/**
	 * A call: one on a hold this side does not know is ignored (Q1), more than this side's N at once and compressed
	 * arguments from a child (clients never compress) are protocol errors. On a relayed hold it is forwarded, its
	 * arguments checked against this link's part limit first (the bytes are here). On a served hold that is not callable
	 * (not bound yet, nor rebinding by the names its consumer still has after a `loading`) it is
	 * refused `not_ready`; its method is an index into the bound variant (one outside it is a protocol error) and its
	 * arguments are opened and parsed here within the hold's limits (past one the call fails `too_large/part`; a
	 * malformed part is a protocol error), absent ones `null`. Arguments this host must inflate asynchronously are
	 * inflated first, then the call is handled again.
	 */
	#call(message: Extract<Message, { readonly kind: "call" }>): void | Promise<void> {
		if (this.#calls.has(message.call)) throw new Error(`call ${message.call}: the id is in use`);
		const hold = this.#entries.get(message.hold);
		if (hold === undefined) return;
		// No window announced (a trusted link): no count closes the link (decision "Call windows only for untrusted links").
		if (this.#limit !== undefined && this.#calls.size >= this.#limit) {
			throw new Error(`call ${message.call}: more than ${this.#limit} calls`);
		}
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
			const relayed = new RelayedCall(hold, message);
			this.#calls.set(message.call, relayed);
			// Registered first: a hold without an upstream link answers at once.
			hold.submit(relayed);
			return;
		}
		if (!hold.callable) {
			this.#refuse(message.call, hold.refusal);
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
		// The caller's span over the link: its carrier with this host's adapter (absent or unknown: the adapter's root).
		const parent = parentOf(message.trace, this.link.host.telemetry);
		// Old work of another host's reload (`call.old`), honoured only from a trusted link (decision "Reload restarts
		// every affected object"): it runs on open old attempts here, and counts as this host's old work while it runs.
		if (message.old === true && this.link.trusted) {
			const { oldWork } = this.link.host;
			oldWork.open();
			const close = (): void => oldWork.close();
			this.#run(message.call, call, method.name, args, parent, asRemoteOldWork(this.link.context)).then(
				close,
				close,
			);
			return;
		}
		this.#run(message.call, call, method.name, args, parent, this.link.context);
	}

	/**
	 * Runs a call under `scope` (the link's context, marked when it is another host's old work) and sends its result
	 * (absent when `null`) or error, unless it was aborted, released or gone meanwhile. A result that cannot be encoded
	 * is sent as its error. Returns the handler's settling.
	 */
	#run(
		id: number,
		call: Extract<RunningCall, { readonly kind: "served" }>,
		method: string,
		args: unknown,
		parent: TelemetryContext,
		scope: Context,
	): Promise<unknown> {
		const context = withAbortSignal(call.abort.signal, scope);
		let running: Promise<unknown>;
		try {
			running = call.hold.call(method, args, parent, context);
		} catch (error) {
			running = Promise.reject(error);
		}
		running.then(
			(result) => {
				let reply: Extract<OriginMessage, { readonly kind: "result" | "error" }>;
				try {
					reply =
						result === null || result === undefined
							? { kind: "result", call: id }
							: this.#result(id, result, call.bytes, this.link.context);
				} catch (error) {
					reply = { kind: "error", call: id, error: wireError(error) };
				}
				this.reply(id, reply);
			},
			(error: unknown) => this.reply(id, { kind: "error", call: id, error: wireError(error) }),
		);
		return running;
	}

	/** Answers call `id` with `error` before it was admitted: it took no slot. */
	#refuse(id: number, error: ChordError): void {
		this.send({ kind: "error", call: id, error: wireError(error) });
	}

	#abort(id: number): void {
		const call = this.#calls.get(id);
		if (call === undefined) return;
		this.#calls.delete(id);
		if (call.kind === "served") {
			call.abort.abort(new ChordError({ code: "aborted", message: `call ${id}: aborted by its caller` }));
			return;
		}
		// A call still waiting for its upstream window leaves it unsent; one forwarded is aborted upstream, then frees its
		// slot (the upstream counts it until the abort).
		if (call.unqueue()) return;
		call.hold.abort(id);
		call.end();
	}

	/**
	 * An `ack` answers the oldest message in flight: this host's own frees a slot, a relayed one is acknowledged to its
	 * upstream link (closed meanwhile: nothing to do). An ack crossing nothing in flight is ignored. Before a relayed
	 * `bound`'s ack goes upstream (the provider there stops decoding the old indexes then), the calls of the holds it
	 * bound still waiting for the upstream window are rejected `unavailable`: they crossed the `loading` notice and carry
	 * the old indexes; calls arriving after this ack were made with the new binding.
	 */
	#ack(): void {
		const sender = this.#sent.shift();
		if (sender === undefined) return;
		switch (sender.kind) {
			case "local":
				this.#inFlight--;
				this.#ownAcked++;
				this.#slotFreed();
				return;
			case "bound":
				for (const id of sender.holds) {
					const hold = this.#relayedHold(id, sender.from);
					if (hold === undefined) continue;
					const error = new ChordError({ code: "unavailable", message: `hold ${id}: rebound` });
					this.#rejectRelayed(hold, error, "queued");
				}
				break;
			case "state":
				break;
		}
		// A relayed message implies the relay's number.
		sender.from.send({ kind: "ack", origin: this.#relay!.origin });
	}

	/**
	 * An event `ack`: its consumer consumed `count` more `event` messages of this origin, the first tickets: this host's
	 * own free slots of its event window, a relayed one is returned to its upstream link (summed per link into one ack;
	 * a link closed meanwhile takes nothing). Separate from the state window and its fence.
	 */
	#eventAck(count: number): void {
		let returned: Map<HostLink, number> | undefined;
		for (let consumed = 0; consumed < count; consumed++) {
			const ticket = this.#tickets.shift();
			if (ticket === undefined) break;
			if (ticket.kind === "local") {
				this.#eventsInFlight--;
				continue;
			}
			returned ??= new Map();
			returned.set(ticket.from, (returned.get(ticket.from) ?? 0) + 1);
		}
		// A relayed ticket implies the relay's number.
		for (const [link, events] of returned ?? []) link.send({ kind: "ack", origin: this.#relay!.origin, events });
	}

	/** The number the next of this host's own `bound` and `state` messages gets (counted from 1). */
	get nextOwn(): number {
		return this.#ownSent + 1;
	}

	/**
	 * Whether its consumer acknowledged this host's own message number `own`, so applied it: a call it sent after that
	 * arrives after the `ack` (one direction keeps its order).
	 */
	acknowledged(own: number): boolean {
		return this.#ownAcked >= own;
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
		// A hold touched in this batch may have left its binding since (a reload unbound it).
		if (this.#free) {
			const entries: StateEntry[] = [];
			for (const hold of holds) if (hold.bound) entries.push(hold.entry(context));
			if (entries.length > 0) this.#sendOwn({ kind: "state", holds: entries });
			return;
		}
		// A bound hold never waits for its binding.
		for (const hold of holds) {
			if (!hold.bound) continue;
			hold.queue();
			this.#waiting.add(hold);
			this.#waitingSince ??= performance.now();
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
				this.#sendWaiting(context);
			} else {
				return;
			}
		}
	}

	/**
	 * The waiting state as one `state` message, taking a slot: a freed one, or one past the window before an answer.
	 * Waiting bindings take the next slot.
	 */
	#sendWaiting(context: Context): void {
		const holds = [...this.#waiting];
		this.#waiting.clear();
		this.#waited();
		this.#bindingTurn = this.#binding.size > 0;
		this.#sendOwn({ kind: "state", holds: holds.map((hold) => hold.pendingEntry(context)) });
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

	/** The waiting state went out (or its holds left): how long it waited for its slot is recorded. */
	#waited(): void {
		if (this.#waitingSince === undefined) return;
		this.link.host.metrics.histogram("chord.backpressure.wait").record(performance.now() - this.#waitingSince);
		this.#waitingSince = undefined;
	}

	/** Sends one of this host's own `bound` or `state` messages, taking a slot. */
	#sendOwn(message: Extract<OriginMessage, { readonly kind: "bound" | "state" }>): void {
		this.#inFlight++;
		this.#ownSent++;
		this.#sent.push(LOCAL);
		if (message.kind === "state") this.link.host.metrics.counter("chord.link.state_messages").add(1);
		this.send(message);
	}
}
