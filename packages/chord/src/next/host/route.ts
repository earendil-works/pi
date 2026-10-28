// Routes (§3): how a host reaches hosts of one kind. `authorize` admits each hold routed over the route; `resolve`
// makes the link of one address, at most once at a time, again after the link drops while holds exist, with a
// backoff per address.

import type { Context } from "../../context/index.ts";
import type { Address, HostKind, KindShape } from "../contracts/index.ts";
import { kindParams, type ParamsData } from "../contracts/internal.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { checkAddress } from "../data/internal.ts";
import type { Codec, Link, PartLimits } from "../link/index.ts";
import { type HostLink, Path, type Upstream } from "../remote/internal.ts";
import { Backoff } from "./backoff.ts";
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

/** One address of a route: its path (link and holders) and whether its `resolve` runs. */
type Routed = { readonly address: Address; readonly path: Path; resolving: boolean };

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
	/** The addresses' links, which tell their address when they open or close. */
	readonly #links = new Map<HostLink, Routed>();
	/** Per address key, separate from objects' identities. */
	readonly #backoff = new Backoff((key) => this.#due(key));

	constructor(kind: HostKind, options: RouteOptions<Principal, KindShape>, host: AnyHost, context: Context) {
		this.kind = kind.kind;
		this.#params = kindParams(kind);
		this.#options = options;
		this.#host = host;
		this.#context = context;
	}

	/**
	 * The path to the address with `params`, for a hold acting as `principal`: the params checked against the kind
	 * (`invalid/placement`), then `authorize` (`forbidden` when it refuses; a throw is the hold's failure).
	 */
	path(params: unknown, principal: Principal | undefined, context: Context): Path {
		const address = checkAddress(this.kind, this.#params, params, context);
		if (principal === undefined || !this.#options.authorize(principal, address)) {
			throw new ChordError({ code: "forbidden", message: `${address.key}: not authorized` });
		}
		let routed = this.#addresses.get(address.key);
		if (routed === undefined) {
			const made: Routed = { address, path: new Path(() => this.#check(made)), resolving: false };
			routed = made;
			this.#addresses.set(address.key, made);
		}
		return routed.path;
	}

	/** One of this route's links completed its handshake: its address's backoff is over. */
	opened(link: HostLink): void {
		const routed = this.#links.get(link);
		if (routed !== undefined) this.#backoff.delete(routed.address.key);
	}

	/** One of this route's links closed: the address waits its backoff, then resolves again while it has holders. */
	closed(link: HostLink): boolean {
		const routed = this.#links.get(link);
		if (routed === undefined) return false;
		this.#links.delete(link);
		if (!this.#host.closing) this.#backoff.failed(routed.address.key);
		routed.path.disconnected(link);
		return true;
	}

	/** The host closes: no address resolves again. Returns every holder of every path, for the host to end. */
	close(): Upstream[] {
		this.#backoff.clear();
		return [...this.#addresses.values()].flatMap(({ path }) => path.holders());
	}

	/**
	 * An address's holders or link changed: it resolves when it has holders, no link, no `resolve` running and no
	 * backoff window; it is forgotten when it has neither holders, a link nor a running `resolve`.
	 */
	#check(routed: Routed): void {
		const { path, address } = routed;
		if (path.link !== undefined || routed.resolving || this.#host.closing) return;
		if (!path.held) {
			this.#addresses.delete(address.key);
			return;
		}
		if (!this.#backoff.waiting(address.key)) void this.#resolve(routed);
	}

	/** A backoff window ended. */
	#due(key: string): void {
		const routed = this.#addresses.get(key);
		if (routed === undefined) this.#backoff.delete(key);
		else this.#check(routed);
	}

	/**
	 * Runs `resolve` once for the address. A rejection, or a link closed already, starts the address's backoff; a link
	 * returned after the host closed is closed at once.
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
			this.#backoff.failed(key);
			this.#check(routed);
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
			this.#backoff.failed(key);
			this.#check(routed);
			return;
		}
		this.#links.set(link, routed);
		// A peer that greeted first had its `hello` handled while the link was made, before it was registered here.
		if (link.greeted) this.#backoff.delete(key);
		routed.path.connected(link);
	}
}
