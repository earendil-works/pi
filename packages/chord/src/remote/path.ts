// Paths (§3 recovery): where this host's upstream holds go, the parent link or a route address's link, across links.
// Each new link of a path holds every holder of the path again; when it drops, every holder is told.

import { ChordError } from "../data/index.ts";
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

const RELEASED: PathEvent = { kind: "released" };

const DROPPED: PathEvent = { kind: "dropped" };

/**
 * The parent link or one route address: its current link and its holders, held on that link and again on every next
 * one. `changed` runs when it gets a holder without a link, loses its link or its last holder (a route decides whether
 * to resolve), saying which.
 */
export class Path {
	readonly #holders = new Set<Upstream>();
	readonly #changed: (event: PathEvent) => void;
	#link: HostLink | undefined;
	/** Whether it ever had a link: a host never connected to a parent has no parent path to wait on. */
	#linked = false;

	constructor(changed: (event: PathEvent) => void) {
		this.#changed = changed;
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

	/** Holds `holder` over this path: on the current link now, and on every next one. */
	attach(holder: Upstream): void {
		this.#holders.add(holder);
		if (this.#link === undefined) this.#changed({ kind: "attached", holder });
		else holder.attach(this.#link);
	}

	/** `holder` was released or ended; no later link holds it. */
	detach(holder: Upstream): void {
		this.#holders.delete(holder);
		if (this.#holders.size === 0) this.#changed(RELEASED);
	}

	/** `link` is the path's link now: every holder is held on it. */
	connected(link: HostLink): void {
		this.#link = link;
		this.#linked = true;
		for (const holder of this.#holders) holder.attach(link);
	}

	/** `link` closed (its sides ended their calls already): every holder goes loading until the next link. */
	disconnected(link: HostLink): void {
		if (this.#link !== link) return;
		this.#link = undefined;
		const error = new ChordError({ code: "unavailable", message: "the link closed" });
		for (const holder of this.#holders) holder.dropped(error);
		this.#changed(DROPPED);
	}

	/** Its address cannot be reached for now (a route's `resolve` failed, a suspension): every holder fails waiting. */
	unreachable(error: ChordError): void {
		for (const holder of this.#holders) holder.unreachable(error);
	}

	/** Every holder, for the host's close. */
	holders(): Upstream[] {
		return [...this.#holders];
	}
}
