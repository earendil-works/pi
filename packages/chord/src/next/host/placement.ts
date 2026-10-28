// Placement (§3, section 1's table): where a reference made on a host, or a hold arriving on one of its links, goes:
// here, over the route of its placement's address, or over the parent link; and the check that an object served here
// is placed here.

import type { Context } from "../../context/index.ts";
import type { Address, Contract, ParamsOf } from "../contracts/index.ts";
import { contractData } from "../contracts/internal.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { WireAddress } from "../link/internal.ts";
import type { HoldRequest, HostLink, Path } from "../remote/internal.ts";
import type { Served } from "./object.ts";
import type { Route } from "./route.ts";

/** Where something goes: here, or over a path (with the address it was placed at, if its type has placement). */
export type Placed =
	| { readonly kind: "here" }
	| { readonly kind: "path"; readonly path: Path; readonly address: WireAddress | undefined };

/** A host's placement: its address, its served types, its routes and its parent path, as the host keeps them. */
export class Placement {
	readonly #address: Address | undefined;
	readonly #types: ReadonlyMap<string, Served>;
	readonly #routes: ReadonlyMap<string, Route>;
	readonly #parent: Path;

	constructor(
		address: Address | undefined,
		types: ReadonlyMap<string, Served>,
		routes: ReadonlyMap<string, Route>,
		parent: Path,
	) {
		this.#address = address;
		this.#types = types;
		this.#routes = routes;
		this.#parent = parent;
	}

	/**
	 * Where a reference to `Type` with `params` made as `principal` goes: here when its type is served here and placed
	 * here (or this host has no address, or the type no placement); otherwise over the route of its placement's kind,
	 * or over the parent link (placement decides where an object lives: a worker reaches another worker's object of a
	 * type it serves too). Throws `invalid/placement` for a placement whose params do not fit its kind, `forbidden` when
	 * the route refuses, and what a placement or `authorize` throws.
	 */
	reference(Type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined, context: Context): Placed {
		const address = placementOf(Type, params);
		if (this.#types.has(Type.name) && this.#placedHere(address)) return HERE;
		return { kind: "path", path: this.#pathTo(address, principal, context) ?? this.#parent, address };
	}

	/**
	 * Where a hold arriving on `link` acting as `principal` goes: here when its type is served here; over the route of
	 * the address it names; else over the parent link, unless it came on the parent link or there is none
	 * (`unavailable`). Throws as `reference` does.
	 */
	hold(request: HoldRequest, link: HostLink, principal: Principal | undefined, context: Context): Placed {
		if (this.#types.has(request.type)) return HERE;
		const { address } = request;
		const routed = this.#pathTo(address, principal, context);
		if (routed !== undefined) return { kind: "path", path: routed, address };
		if (link.role === "parent" || this.#parent.link === undefined) {
			throw new ChordError({ code: "unavailable", message: `${request.type} is not served here` });
		}
		return { kind: "path", path: this.#parent, address };
	}

	/**
	 * Throws `invalid/placement` for a hold of `Type` with `params` (checked) served here but placed on another host
	 * (misrouted; never forwarded). The placement is computed here from the params: the address a hold names only
	 * routes it.
	 */
	assertHere(Type: Contract, params: ParamsOf<Contract>): void {
		const address = placementOf(Type, params);
		if (this.#placedHere(address)) return;
		throw invalid("placement", `${Type.name}: placed on ${address!.kind}, this host is ${this.#address!.key}`);
	}

	/**
	 * The path to `address` when this host routes its kind (its params checked, `authorize` run for `principal`);
	 * `undefined` without an address or a route for its kind.
	 */
	#pathTo(address: WireAddress | undefined, principal: Principal | undefined, context: Context): Path | undefined {
		if (address === undefined) return undefined;
		return this.#routes.get(address.kind)?.path(address.params, principal, context);
	}

	/** Whether an object placed at `address` lives here: this host has no address, the type no placement, or equal. */
	#placedHere(address: WireAddress | undefined): boolean {
		const own = this.#address;
		return own === undefined || address === undefined || sameAddress(own, address);
	}
}

const HERE: Placed = { kind: "here" };

/** The address `Type`'s placement computes for `params`; `undefined` for a type without placement. */
function placementOf(Type: Contract, params: ParamsOf<Contract>): WireAddress | undefined {
	const placement = contractData(Type).placement;
	if (placement === undefined) return undefined;
	// Plugin code: what it returns is checked where it is routed or served.
	const { kind, params: values } = placement(params) as { readonly kind: string; readonly params: unknown };
	return { kind, params: values };
}

/** Whether `address` names the host at `own`: the same kind and the same value for each of its params. */
function sameAddress(own: Address, address: WireAddress): boolean {
	if (own.kind !== address.kind || typeof address.params !== "object" || address.params === null) return false;
	const values = address.params as { readonly [field: string]: unknown };
	const fields = Object.keys(own.params);
	return Object.keys(values).length === fields.length && fields.every((field) => values[field] === own.params[field]);
}
