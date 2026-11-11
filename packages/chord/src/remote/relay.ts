// Relayed holds (§4, §22, R1; decision "Relay flow control per origin"): a hold that arrived on one link (downstream)
// and that this host neither serves nor parses, held again on its path's link (upstream) with the same id under its
// downstream origin's number there; messages are forwarded between the two with the origin rewritten and parts
// untouched. Forwarding a hold or a call is a `chord.relay` span under the arriving carrier, whose own carrier goes
// upstream (slice 9).

import type { TelemetryCarrier, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { ChordError } from "../data/index.ts";
import type { Caller } from "../host/internal.ts";
import { errorFromWire, type Message, type OriginMessage, wireError } from "../link/internal.ts";
import { capped, carrierOf, ended, OpenSpan, parentOf, spanFailed, untraced } from "../telemetry.ts";
import type { CallWindow } from "./calls.ts";
import { actingFor, type HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import type { ProviderSide } from "./provider.ts";

/** A `call` message. */
type CallMessage = Extract<Message, { readonly kind: "call" }>;

/**
 * Where a relayed call stands: registered (`new`, answered at once when its hold has no upstream link), waiting in its
 * upstream link's window for its origin (`queued`), forwarded upstream (`forwarded`, its `chord.relay` span when this
 * host records), or `ended` (answered, aborted, its hold or origin gone).
 */
type RelayedCallState =
	| { readonly kind: "new" }
	| { readonly kind: "queued"; readonly window: CallWindow<RelayedCall> }
	| {
			readonly kind: "forwarded";
			readonly window: CallWindow<RelayedCall>;
			readonly span: OpenSpan<"chord.relay"> | undefined;
	  }
	| { readonly kind: "ended" };

const NEW: RelayedCallState = { kind: "new" };

const ENDED: RelayedCallState = { kind: "ended" };

/**
 * A downstream call on a relayed hold, as its downstream origin keeps it (decision "Call windows only for untrusted
 * links": a relay honours each upstream window): queued in its upstream link's window for the origin until a slot
 * forwards it (`send`), then in flight until its reply, its abort, its hold's end or the upstream's drop.
 */
export class RelayedCall {
	readonly kind = "relayed";
	readonly hold: RelayedHold;
	readonly message: CallMessage;
	#state: RelayedCallState = NEW;

	constructor(hold: RelayedHold, message: CallMessage) {
		this.hold = hold;
		this.message = message;
	}

	/** Whether it was forwarded upstream and is not answered yet. */
	get forwarded(): boolean {
		return this.#state.kind === "forwarded";
	}

	/** Waits in `window` (its hold's upstream link's, for its origin), forwarded at once when a slot is free. */
	queue(window: CallWindow<RelayedCall>): void {
		this.#state = { kind: "queued", window };
		window.submit(this);
	}

	/** Its window has a slot for it: forwarded upstream. */
	send(): void {
		// A window sends only the calls queued in it.
		const { window } = this.#state as Extract<RelayedCallState, { readonly kind: "queued" }>;
		this.#state = { kind: "forwarded", window, span: this.hold.call(this.message) };
	}

	/** Takes it out of its window when it still waits there (ended unsent); whether it did. */
	unqueue(): boolean {
		const state = this.#state;
		if (state.kind !== "queued") return false;
		this.#state = ENDED;
		state.window.remove(this);
		return true;
	}

	/**
	 * Ends it: a waiting one leaves its window, a forwarded one frees its slot (which may forward the next waiting call)
	 * and its span ends with `reply` (none: `aborted`).
	 */
	end(reply?: Extract<OriginMessage, { readonly kind: "result" | "error" }>): void {
		const state = this.#state;
		this.#state = ENDED;
		if (state.kind === "queued") state.window.remove(this);
		if (state.kind !== "forwarded") return;
		if (state.span !== undefined) relayEnded(state.span, reply);
		state.window.freed();
	}
}

/**
 * Ends `calls` (of one hold or origin): the waiting ones leave their windows first, so a slot a forwarded one frees
 * never forwards one of them.
 */
export function endAll(calls: readonly RelayedCall[]): void {
	for (const call of calls) call.unqueue();
	for (const call of calls) call.end();
}

/**
 * One relayed hold: `id` on its downstream origin, and the same id upstream on its path's current link (none while
 * the path has no link). It keeps its `hold` message to hold again on the next link. Calls, `abort`, `retry` and
 * `release` go upstream at once; what comes back is forwarded by its downstream origin (`ProviderSide.forward`). Two
 * downstream holds are two upstream holds, each with its own encoders (R1).
 */
export class RelayedHold {
	readonly kind = "relayed";
	readonly id: number;
	readonly #downstream: ProviderSide;
	/**
	 * What the upstream hold asks for, with the chain and decoded limit this host honoured; its params owned, not a view
	 * of the message they came in.
	 */
	readonly #request: HoldRequest;
	/** Whom the hold acts for, sent on route links. */
	readonly caller: Caller;
	readonly #path: Path;
	/** The upstream link while the path has one, and the downstream origin's number on it. */
	#upstream: { readonly link: HostLink; readonly origin: number } | undefined;
	/** Its `chord.relay` span until it is first held upstream (or dropped); none when this host records nothing. */
	#relaying: OpenSpan<"chord.relay"> | undefined;
	/**
	 * The carrier of its first upstream hold: the relay span's, or the arriving one as it came when this host records
	 * nothing; a re-hold's span links to it.
	 */
	readonly #trace: TelemetryCarrier | undefined;
	/** How many times it was held upstream. */
	#holds = 0;

	constructor(id: number, downstream: ProviderSide, request: HoldRequest, caller: Caller, path: Path) {
		this.id = id;
		this.#downstream = downstream;
		const { params, trace, ...fields } = request;
		// Params are never deflated: the provider side refused deflated ones.
		const owned = typeof params === "string" ? params : (params as Uint8Array).slice();
		this.#request = { ...fields, params: owned };
		this.#trace = trace;
		const adapter = downstream.link.host.telemetry;
		if (!untraced(adapter)) {
			this.#relaying = new OpenSpan(parentOf(trace, adapter), "chord.relay", this.#attributes("hold"));
			// Upstream the hold carries the relay's span (a relay that records nothing passes the carrier on as it came).
			this.#trace = carrierOf(this.#relaying.span) ?? trace;
		}
		this.caller = caller;
		this.#path = path;
	}

	/** Its `chord.relay` span until it is held upstream (a route's resolve links to it); none when not recorded. */
	get span(): TelemetrySpan | undefined {
		return this.#relaying?.span;
	}

	/** Takes the pending hold's place downstream and holds upstream (now, or when the path has a link). */
	start(): void {
		this.#downstream.relayed(this);
		this.#path.attach(this);
	}

	/** Whether it is held on `link` now: only that link answers for it. */
	heldOn(link: HostLink): boolean {
		return this.#upstream?.link === link;
	}

	/** Holds on `link`, the path's link now: its kept `hold` message, with whom it acts for on a route link. */
	attach(link: HostLink): void {
		const origin = this.#downstream.relayTo(link);
		this.#upstream = { link, origin };
		const trace = this.#holdTrace(link);
		link.send({
			kind: "hold",
			origin,
			hold: this.id,
			...this.#request,
			...(trace === undefined ? {} : { trace }),
			...actingFor(link, this.caller),
		});
		this.#relayed("ok");
	}

	/**
	 * The carrier of this upstream hold: the first one's; a re-hold after an upstream drop is a fresh `chord.relay` root
	 * linked to the first (none when this host records nothing), never the first's again (review L1).
	 */
	#holdTrace(link: HostLink): TelemetryCarrier | undefined {
		if (this.#holds++ === 0) return this.#trace;
		const adapter = link.host.telemetry;
		if (this.#trace === undefined || untraced(adapter)) return undefined;
		const again = new OpenSpan(adapter, "chord.relay", this.#attributes("hold"));
		again.span.addLink({ context: parentOf(this.#trace, adapter) });
		const carrier = carrierOf(again.span);
		again.span.setAttributes({ outcome: "ok" });
		again.end();
		return carrier;
	}

	/**
	 * A relay span's attributes: its host's `chord.host` (the downstream link's host), and names from the wire, bounded
	 * by the message schema (untrusted links) and capped here.
	 */
	#attributes(member: string): { "chord.host": string; type: string; member: string; "upstream.kind": string } {
		const { type, address } = this.#request;
		return {
			"chord.host": this.#downstream.link.host.spanHost,
			type: capped(type),
			member,
			"upstream.kind": capped(address.kind),
		};
	}

	/** The upstream link dropped: downstream its calls fail and the hold goes loading until the path's next link. */
	dropped(error: ChordError): void {
		const upstream = this.#upstream;
		this.#upstream = undefined;
		if (upstream !== undefined) this.#downstream.upstreamDropped(this, error);
	}

	/** Its path's address cannot be reached for now: downstream it fails `waiting` with `error` until the next link. */
	unreachable(error: ChordError): void {
		this.#relayed("error", error);
		this.#downstream.send({ kind: "failed", hold: this.id, cause: { kind: "waiting", error: wireError(error) } });
	}

	/**
	 * Whether it waits for its path's link (a route still resolving, or a dropped link's next): a revocation ends it then,
	 * since the link it is held on next gets no past `revoke` (§4).
	 */
	get waiting(): boolean {
		return this.#upstream === undefined;
	}

	/** Revoked while it waited for its path's link: forgotten, and `gone` with `error` downstream. */
	revoked(error: ChordError): void {
		this.drop();
		this.#downstream.forget(this);
		this.#downstream.send({ kind: "gone", hold: this.id, error: wireError(error) });
	}

	/** `gone` from upstream: the hold is forgotten (the downstream origin forwards the message). */
	lost(): void {
		this.drop();
		this.#downstream.forget(this);
	}

	/**
	 * A call from downstream (registered there under its id): it waits in its upstream link's window for this origin
	 * and is forwarded (`call`) as a slot frees, at once when one is free and nothing waits (a trusted upstream announced
	 * no window); its reply comes back by the origin. Without an upstream link it is answered `unavailable` at once (it
	 * crossed the `loading` notice).
	 */
	submit(call: RelayedCall): void {
		const upstream = this.#upstream;
		if (upstream === undefined) {
			const error = new ChordError({ code: "unavailable", message: `hold ${this.id}: its upstream link is down` });
			this.#downstream.reply(call.message.call, { kind: "error", call: call.message.call, error: wireError(error) });
			return;
		}
		call.queue(upstream.link.consumer.relayWindow(upstream.origin));
	}

	/**
	 * Forwards a submitted call upstream, now that its window has a slot; returns its `chord.relay` span when this host
	 * records.
	 */
	call(message: CallMessage): OpenSpan<"chord.relay"> | undefined {
		// A call waits only in its hold's current upstream window: the drop answers it first (`upstreamDropped`), a
		// release forgets it.
		const upstream = this.#upstream!;
		// A downstream link that is not trusted (a page) cannot claim old work: its flag is dropped here.
		const forwarded = message.old === true && !this.#downstream.link.trusted ? unmarked(message) : message;
		const adapter = upstream.link.host.telemetry;
		if (untraced(adapter)) {
			upstream.link.send({ ...forwarded, origin: upstream.origin });
			return undefined;
		}
		const span = new OpenSpan(
			parentOf(message.trace, adapter),
			"chord.relay",
			this.#attributes(`#${message.method}`),
		);
		const trace = carrierOf(span.span) ?? message.trace;
		upstream.link.send({ ...forwarded, origin: upstream.origin, ...(trace === undefined ? {} : { trace }) });
		return span;
	}

	/** A downstream `abort` of call `id`, forwarded. */
	abort(id: number): void {
		const upstream = this.#upstream;
		upstream?.link.send({ kind: "abort", origin: upstream.origin, call: id });
	}

	/** A downstream `retry`, forwarded with its hop budget as it is (a relay visits no object). */
	retry(message: Extract<Message, { readonly kind: "retry" }>): void {
		const upstream = this.#upstream;
		upstream?.link.send({ ...message, origin: upstream.origin });
	}

	/** Released downstream: released upstream (its calls with it) and no later link holds it. */
	release(): void {
		const upstream = this.#upstream;
		this.drop();
		upstream?.link.send({ kind: "release", origin: upstream.origin, hold: this.id });
	}

	/** No later link holds it (gone, or its downstream origin closed, which `closed` tells the upstream links). */
	drop(): void {
		this.#relayed("aborted");
		this.#upstream = undefined;
		this.#path.detach(this);
	}

	/** It was held upstream, failed or dropped first: its `chord.relay` span ends with `outcome`. */
	#relayed(outcome: "ok" | "error" | "aborted", error?: ChordError): void {
		const relaying = this.#relaying;
		if (relaying === undefined) return;
		this.#relaying = undefined;
		if (error !== undefined) spanFailed(relaying.span, "relay_failed", error);
		relaying.span.setAttributes({ outcome });
		relaying.end();
	}
}

/**
 * A relayed call's `chord.relay` span ends with its `reply` forwarded downstream (`ok`, or the error's: `aborted` for
 * a cancel), or `aborted` without one (an abort, a release, a closed link).
 */
export function relayEnded(
	span: OpenSpan<"chord.relay">,
	reply: Extract<OriginMessage, { readonly kind: "result" | "error" }> | undefined,
): void {
	const outcome =
		reply === undefined
			? "aborted"
			: reply.kind === "result"
				? "ok"
				: ended(span.span, "relay_failed", errorFromWire(reply.error), undefined);
	span.span.setAttributes({ outcome });
	span.end();
}

/** `message` without its old-work flag (`call.old`), as a relay forwards it from a link that is not trusted. */
function unmarked(message: CallMessage): CallMessage {
	const { old: _old, ...rest } = message;
	return rest;
}
