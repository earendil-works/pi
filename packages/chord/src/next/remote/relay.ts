// Relayed holds (§4, §22, R1; decision "Relay flow control per origin"): a hold that arrived on one link (downstream)
// and that this host neither serves nor parses, held again on its path's link (upstream) with the same id under its
// downstream origin's number there; messages are forwarded between the two with the origin rewritten and parts
// untouched.

import { ChordError } from "../data/index.ts";
import type { Caller } from "../host/internal.ts";
import { type Message, wireError } from "../link/internal.ts";
import { actingFor, type HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import type { ProviderSide } from "./provider.ts";

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

	constructor(id: number, downstream: ProviderSide, request: HoldRequest, caller: Caller, path: Path) {
		this.id = id;
		this.#downstream = downstream;
		const { params } = request;
		// Params are never deflated: the provider side refused deflated ones.
		const owned = typeof params === "string" ? params : (params as Uint8Array).slice();
		this.#request = { ...request, params: owned };
		this.caller = caller;
		this.#path = path;
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
		link.send({ kind: "hold", origin, hold: this.id, ...this.#request, ...actingFor(link, this.caller) });
	}

	/** The upstream link dropped: downstream its calls fail and the hold goes loading until the path's next link. */
	dropped(error: ChordError): void {
		const upstream = this.#upstream;
		this.#upstream = undefined;
		if (upstream !== undefined) this.#downstream.upstreamDropped(this, error);
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
	 * A call from downstream (registered there under its id), forwarded upstream at once; its reply comes back by the
	 * origin. Without an upstream link it is answered `unavailable` at once (it crossed the `loading` notice).
	 */
	call(message: Extract<Message, { readonly kind: "call" }>): void {
		const upstream = this.#upstream;
		if (upstream !== undefined) {
			upstream.link.send({ ...message, origin: upstream.origin });
			return;
		}
		const error = new ChordError({ code: "unavailable", message: `hold ${this.id}: its upstream link is down` });
		this.#downstream.reply(message.call, { kind: "error", call: message.call, error: wireError(error) });
	}

	/** A downstream `abort` of call `id`, forwarded. */
	abort(id: number): void {
		const upstream = this.#upstream;
		upstream?.link.send({ kind: "abort", origin: upstream.origin, call: id });
	}

	/** A downstream `retry`, forwarded. */
	retry(): void {
		const upstream = this.#upstream;
		upstream?.link.send({ kind: "retry", origin: upstream.origin, hold: this.id });
	}

	/** Released downstream: released upstream (its calls with it) and no later link holds it. */
	release(): void {
		const upstream = this.#upstream;
		this.drop();
		upstream?.link.send({ kind: "release", origin: upstream.origin, hold: this.id });
	}

	/** No later link holds it (gone, or its downstream origin closed, which `closed` tells the upstream links). */
	drop(): void {
		this.#upstream = undefined;
		this.#path.detach(this);
	}
}
