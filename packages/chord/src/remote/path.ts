// Paths (§3 recovery): where this host's upstream holds go, the parent link or a route address's link, across links.
// Each new link of a path holds every holder of the path again; when it drops, every holder is told. A route with
// an admission gates its paths (slice 14 §2.3): a holder is forwarded only while its decision allows it, released
// when it is denied, and forwarded again behind a fence.

import { ChordError, type FailureCause } from "../data/index.ts";
import type { HostLink } from "./host-link.ts";
import type { RelayedHold } from "./relay.ts";
import type { RemoteObject } from "./remote-object.ts";

/** What a path holds on its links: one of this host's remote references, or a hold it relays. */
export type Upstream = RemoteObject | RelayedHold;

/**
 * What changed on a path without a link, for its route: a holder attached, its link dropped (its holders went
 * loading), its last holder left.
 */
export type PathEvent =
	| { readonly kind: "attached"; readonly holder: Upstream }
	| { readonly kind: "dropped" }
	| { readonly kind: "released" };

/**
 * What decides whether a path forwards a holder (a route's admission, one decision per principal and address). It
 * forwards a holder it held back with `Path.forward`, and takes one back with `Path.withhold`.
 */
export type PathGate = {
	/** `holder` joined the path: whether it is forwarded at once (its principal's decision allows it already). */
	joined(holder: Upstream): boolean;
	/** `holder` left the path. */
	left(holder: Upstream): void;
	/**
	 * The path lost its link (its holders were told): the gate takes back, with `Path.withhold`, the holders it cannot
	 * forward on the next one, so a new link holds only what a decision that can be read allows.
	 */
	unlinked(): void;
};

const RELEASED: PathEvent = { kind: "released" };

const DROPPED: PathEvent = { kind: "dropped" };

/** A path no route suspends: the parent's, the host's unplaced one. */
const NEVER = (): boolean => false;

/**
 * The parent link or one route address: its current link and its holders, held on that link and again on every next
 * one. `changed` runs when it gets a holder without a link, loses its link or its last holder (a route decides whether
 * to resolve), saying which; `suspended` tells whether its route resolves nothing for it now (none for the parent's).
 * With a `gate`, only the holders it admits are held on the links; the others wait withheld, told by the gate.
 */
export class Path {
	readonly #holders = new Set<Upstream>();
	readonly #changed: (event: PathEvent) => void;
	readonly #suspended: () => boolean;
	readonly #gate: PathGate | undefined;
	#link: HostLink | undefined;
	/** Whether it ever had a link: a host never connected to a parent has no parent path to wait on. */
	#linked = false;
	/** The holders its gate holds back (undecided, denied, refused): on no link. Made by the first. */
	#withheld: Set<Upstream> | undefined;
	/**
	 * The holders a denial released on the current link, each with what cancels its fence while one waits for its
	 * `pong` (`forward`); gone with the link. Made by the first.
	 */
	#released: Map<Upstream, (() => void) | undefined> | undefined;

	constructor(changed: (event: PathEvent) => void, suspended: () => boolean = NEVER, gate?: PathGate) {
		this.#changed = changed;
		this.#suspended = suspended;
		this.#gate = gate;
	}

	/**
	 * Whether its route suspended it: a new remote reference then holds on its own instead of sharing a held object's
	 * state (decision "References share one wire hold").
	 */
	get suspended(): boolean {
		return this.#suspended();
	}

	/** The current link while one is open. */
	get link(): HostLink | undefined {
		return this.#link;
	}

	/** Whether it had a link once (it may be down now: its holders wait for the next). */
	get linked(): boolean {
		return this.#linked;
	}

	/** Whether anything is held over this path. */
	get held(): boolean {
		return this.#holders.size > 0;
	}

	/**
	 * Whether a holder wants a link: one its gate admits (every holder without a gate). A route resolves nothing for an
	 * address whose holders are all denied or undecided (slice 14 §2.3).
	 */
	get wanted(): boolean {
		return this.#holders.size > (this.#withheld?.size ?? 0);
	}

	/** Whether its gate holds `holder` back now (it is on no link). */
	withholds(holder: Upstream): boolean {
		return this.#withheld?.has(holder) === true;
	}

	/**
	 * Holds `holder` over this path: on the current link now, and on every next one. A gated path asks its gate first:
	 * a holder it does not admit yet is on no link until `forward`.
	 */
	attach(holder: Upstream): void {
		this.#holders.add(holder);
		const gate = this.#gate;
		if (gate !== undefined) {
			// Withheld while its gate is asked: what the gate tells it meanwhile finds it on no link.
			this.#withheld ??= new Set();
			this.#withheld.add(holder);
			if (!gate.joined(holder)) return;
			this.#withheld.delete(holder);
		}
		if (this.#link === undefined) this.#changed({ kind: "attached", holder });
		else holder.attach(this.#link);
	}

	/**
	 * A reference joined `holder`, which it holds already (decision "References share one wire hold"): without a link
	 * it counts as a new request, as an attach does (a route whose resolve failed resolves again).
	 */
	requested(holder: Upstream): void {
		if (this.#link === undefined && this.#withheld?.has(holder) !== true) this.#changed({ kind: "attached", holder });
	}

	/** `holder` was released or ended; no later link holds it. */
	detach(holder: Upstream): void {
		if (!this.#holders.delete(holder)) return;
		this.#withheld?.delete(holder);
		this.#unfence(holder);
		this.#gate?.left(holder);
		if (this.#holders.size === 0) this.#changed(RELEASED);
	}

	/**
	 * Its gate admits `holder` now: told so (one that was told what held it back is `loading` again until its next
	 * binding), then held on the current link, or the path asks for one. A holder a denial released on
	 * this very link is held again, under its id (relays never renumber, §3), only behind a fence: the release, then a
	 * `ping`, and the hold after that ping's `pong`. A link is ordered and a peer answers a `ping` after everything it
	 * sent before it, so every reply of the released hold has arrived, and was dropped, before the hold exists again.
	 * **This relies on the route's `resolve` returning the link to the final provider that serves the address**, as the
	 * route contract requires: an intermediate relay would answer the `ping` before the final provider's old replies
	 * have drained through it.
	 */
	forward(holder: Upstream): void {
		if (this.#withheld?.delete(holder) !== true) return;
		holder.admitted();
		const link = this.#link;
		if (link === undefined) {
			this.#changed({ kind: "attached", holder });
			return;
		}
		const released = this.#released;
		if (released?.has(holder) !== true) {
			holder.attach(link);
			return;
		}
		const fenced = link.fence(() => {
			released.delete(holder);
			holder.attach(link);
		});
		released.set(holder, fenced);
	}

	/**
	 * Its gate holds `holder` back with `cause` (denied, or a decision that cannot be made): told so, and released on
	 * the link it is held on. A fence still waiting for its `pong` ends: the next allow sends a new one.
	 */
	withhold(holder: Upstream, cause: FailureCause): void {
		if (!this.#holders.has(holder)) return;
		this.#withheld ??= new Set();
		const forwarded = !this.#withheld.has(holder);
		this.#withheld.add(holder);
		this.#released?.get(holder)?.();
		if (this.#link !== undefined && (forwarded || this.#released?.has(holder) === true)) {
			this.#released ??= new Map();
			this.#released.set(holder, undefined);
		}
		holder.withheld(cause);
	}

	/** `link` is the path's link now: every holder its gate admits is held on it, under its current decision. */
	connected(link: HostLink): void {
		this.#link = link;
		this.#linked = true;
		for (const holder of this.#holders) if (this.#withheld?.has(holder) !== true) holder.attach(link);
	}

	/**
	 * `link` closed (its sides ended their calls already): every holder held on it goes loading until the next link.
	 * Its fences go with it, and its gate takes back what it cannot forward now: the next link holds what the gate
	 * admits then.
	 */
	disconnected(link: HostLink): void {
		if (this.#link !== link) return;
		this.#link = undefined;
		for (const cancel of this.#released?.values() ?? []) cancel?.();
		this.#released = undefined;
		const error = new ChordError({ code: "unavailable", message: "the link closed" });
		for (const holder of this.#holders) if (this.#withheld?.has(holder) !== true) holder.dropped(error);
		this.#gate?.unlinked();
		this.#changed(DROPPED);
	}

	/**
	 * Its address cannot be reached for now (a route's `resolve` failed, a suspension): every holder that wants its
	 * link fails waiting.
	 */
	unreachable(error: ChordError): void {
		for (const holder of this.#holders) if (this.#withheld?.has(holder) !== true) holder.unreachable(error);
	}

	/** Forgets what a denial left of `holder` on the current link: its fence is cancelled. */
	#unfence(holder: Upstream): void {
		this.#released?.get(holder)?.();
		this.#released?.delete(holder);
	}

	/** Every holder, for the host's close. */
	holders(): Upstream[] {
		return [...this.#holders];
	}
}
