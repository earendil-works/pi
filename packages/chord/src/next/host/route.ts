// Routes (§3): how a host reaches hosts of one kind. `authorize` admits each hold routed over the route; `resolve`
// makes the link of one address, at most once at a time. No timer (slice 10 R2): an address resolves for a new hold,
// on `RouteHandle.retry`, or once after its link dropped while held; a rejected `resolve` (or a link closed before its
// handshake) fails its holders `failed { waiting }` until then, and a suspended address resolves nothing while held.

import type { Context } from "../../context/index.ts";
import type { Address, HostKind, KindShape } from "../contracts/index.ts";
import { kindParams, type ParamsData } from "../contracts/internal.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { asChordError, checkAddress } from "../data/internal.ts";
import type { Codec, Link, PartLimits } from "../link/index.ts";
import { type HostLink, Path, type PathEvent, type Upstream } from "../remote/internal.ts";
import type { AnyHost } from "./host.ts";

/** What `host.route` takes for a kind. */
export type RouteOptions<P extends Principal, K extends KindShape> = {
	/** Whether `principal` may reach `address`; runs for every hold routed over the route, before anything starts. */
	authorize(principal: P, address: Address<K>): boolean;
	/**
	 * The link to `address`: `principal` is who the host at the other end is, `trusted` skips the message check on it,
	 * `limits` bound its parts (as `accept`'s). `context` is the route's, aborted when this host closes. Runs at most
	 * once at a time per address.
	 */
	resolve(
		address: Address<K>,
		context: Context,
	): Promise<{
		readonly link: Link;
		readonly principal: P;
		readonly trusted?: boolean;
		readonly codec?: Codec;
		readonly limits?: PartLimits;
	}>;
};

/** What `host.route` returns: the app's controls of its addresses (D10b, R1). */
export type RouteHandle<K extends KindShape> = {
	/**
	 * Resolves `address` again now if it has holders and no link: its failure and its suspension end (a Retry button);
	 * an address nobody holds resolves at its next hold.
	 */
	retry(address: Address<K>): void;
	/**
	 * Resolves nothing for `address` while it has holders: they wait `failed { waiting }` ("suspended") once its link is
	 * gone; the suspension ends with its last holder or `retry`.
	 */
	suspend(address: Address<K>): void;
};

/** One address of a route: its path, whether its `resolve` runs, why it fails its holders, whether it is suspended. */
type Routed = {
	readonly address: Address;
	readonly path: Path;
	resolving: boolean;
	/** A rejected `resolve`, or a link closed before its handshake: its holders fail with it until the next resolve. */
	failure: ChordError | undefined;
	suspended: boolean;
};

/**
 * A host's route for one kind. An address is kept while it has holders, a link or a running `resolve`: a resolve whose
 * holds were all released meanwhile finishes, and its link is kept until it closes.
 */
export class Route {
	readonly kind: string;
	readonly #params: ParamsData;
	readonly #options: RouteOptions<Principal, KindShape>;
	readonly #host: AnyHost;
	/** The route's context, aborted when the host closes: every `resolve` and its links' work run under it. */
	readonly #context: Context;
	readonly #addresses = new Map<string, Routed>();
	/** The addresses' links, which tell their address when they close, and whether each completed its handshake. */
	readonly #links = new Map<HostLink, { readonly routed: Routed; greeted: boolean }>();

	constructor(kind: HostKind, options: RouteOptions<Principal, KindShape>, host: AnyHost, context: Context) {
		this.kind = kind.kind;
		this.#params = kindParams(kind);
		this.#options = options;
		this.#host = host;
		this.#context = context;
	}

	/**
	 * The path to the address with `params`, for a hold acting as `principal`: the params checked against the kind
	 * (`invalid/host_address`), then `authorize` (`forbidden` when it refuses; a throw is the hold's failure).
	 */
	path(params: unknown, principal: Principal | undefined, context: Context): Path {
		const address = checkAddress(this.kind, this.#params, params, context);
		if (principal === undefined || !this.#options.authorize(principal, address)) {
			throw new ChordError({ code: "forbidden", message: `${address.key}: not authorized` });
		}
		let routed = this.#addresses.get(address.key);
		if (routed === undefined) {
			const made: Routed = {
				address,
				path: new Path((event) => this.#changed(made, event)),
				resolving: false,
				failure: undefined,
				suspended: false,
			};
			routed = made;
			this.#addresses.set(address.key, made);
		}
		return routed.path;
	}

	/** `RouteHandle.retry`: the address's failure and suspension end; it resolves now if held and unlinked. */
	retry(key: string): void {
		const routed = this.#addresses.get(key);
		if (routed === undefined) return;
		routed.failure = undefined;
		routed.suspended = false;
		this.#resolveIfHeld(routed);
	}

	/** `RouteHandle.suspend`: a held address resolves nothing until `retry` or its last holder; unheld, nothing is kept. */
	suspend(key: string): void {
		const routed = this.#addresses.get(key);
		if (routed === undefined || !routed.path.held) return;
		routed.suspended = true;
		if (routed.path.link === undefined && !routed.resolving) routed.path.unreachable(suspended(routed));
	}

	/** One of this route's links completed its handshake: a later drop of it resolves its address again. */
	opened(link: HostLink): void {
		const entry = this.#links.get(link);
		if (entry !== undefined) entry.greeted = true;
	}

	/**
	 * One of this route's links closed: its address resolves again once while held if the link had completed its
	 * handshake, else its holders fail (no loop over a worker that dies at start).
	 */
	closed(link: HostLink): boolean {
		const entry = this.#links.get(link);
		if (entry === undefined) return false;
		this.#links.delete(link);
		const { routed } = entry;
		if (!entry.greeted) {
			routed.failure = new ChordError({
				code: "unavailable",
				message: `${routed.address.key}: the link closed before its handshake`,
			});
		}
		routed.path.disconnected(link);
		return true;
	}

	/** Every holder of every path of this route, linked or not (revocation ends a revoked principal's). */
	holders(): Upstream[] {
		return [...this.#addresses.values()].flatMap(({ path }) => path.holders());
	}

	/**
	 * An address's path changed without a link: a new holder resolves it (a failed address too: a new hold is a new
	 * request), a dropped link resolves it once (or fails it, closed before its handshake), the last holder's release
	 * forgets it (its failure and suspension too) unless its link or `resolve` keeps it.
	 */
	#changed(routed: Routed, event: PathEvent): void {
		if (this.#host.closing) return;
		switch (event.kind) {
			case "released":
				routed.suspended = false;
				if (routed.path.link === undefined && !routed.resolving) this.#addresses.delete(routed.address.key);
				return;
			case "attached":
				if (routed.suspended) event.holder.unreachable(suspended(routed));
				else if (!routed.resolving) void this.#resolve(routed);
				return;
			case "dropped":
				if (!routed.path.held) this.#addresses.delete(routed.address.key);
				else if (routed.suspended) routed.path.unreachable(suspended(routed));
				else if (routed.failure !== undefined) routed.path.unreachable(routed.failure);
				else void this.#resolve(routed);
		}
	}

	/** Resolves the address if it has holders, no link, no running `resolve` and no suspension. */
	#resolveIfHeld(routed: Routed): void {
		const { path } = routed;
		if (!path.held || path.link !== undefined || routed.resolving || this.#host.closing) return;
		void this.#resolve(routed);
	}

	/**
	 * Runs `resolve` once for the address. A rejection, or a link closed already, fails its holders with the error until
	 * the next resolve; a link returned after the host closed is closed at once.
	 */
	async #resolve(routed: Routed): Promise<void> {
		const key = routed.address.key;
		routed.resolving = true;
		let resolved: Awaited<ReturnType<RouteOptions<Principal, KindShape>["resolve"]>>;
		try {
			resolved = await this.#options.resolve(routed.address, this.#context);
		} catch (error) {
			routed.resolving = false;
			if (this.#host.closing) return;
			this.#host.report({ kind: "resolve_failed", address: key, error });
			this.#settle(routed, asChordError(error, key));
			return;
		}
		routed.resolving = false;
		if (this.#host.closing) {
			resolved.link.close();
			return;
		}
		const { link: made, ...options } = resolved;
		const link = this.#host.routeLink(made, options, this.#context);
		if (!link.open) {
			this.#settle(
				routed,
				new ChordError({ code: "unavailable", message: `${key}: the link closed before its handshake` }),
			);
			return;
		}
		routed.failure = undefined;
		// A peer that greeted first had its `hello` handled while the link was made, before it was registered here.
		this.#links.set(link, { routed, greeted: link.greeted });
		routed.path.connected(link);
	}

	/**
	 * A resolve failed with `error`: its holders fail `failed { waiting }` with it (they stay on its path for its next
	 * link), or the address goes when nobody holds it any more.
	 */
	#settle(routed: Routed, error: ChordError): void {
		if (!routed.path.held) {
			this.#addresses.delete(routed.address.key);
			return;
		}
		routed.failure = error;
		routed.path.unreachable(routed.suspended ? suspended(routed) : error);
	}
}

/** The failure holders of a suspended address see. */
function suspended(routed: Routed): ChordError {
	return new ChordError({ code: "unavailable", message: `${routed.address.key}: suspended` });
}
