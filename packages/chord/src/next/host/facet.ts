// Facets (§16): a plugin's setup for one host, typed by the app's principal type. A setup only declares: the types it
// serves and the host's presence lists; it has no documents, routines or natives, so a facet cannot fail after `load`.

import type { Watchable } from "../../watch.ts";
import type { Contract } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Factory } from "./attempt.ts";
import type { Presence } from "./presence.ts";

/** What a setup serves types with (valid only while the setup runs), and the host's presence lists (always). */
export interface FacetHost<P extends Principal = Principal> {
	/** Serves a type on this host with `factory`; a remote type's factory gets the principal its object is for. */
	serve<C extends Contract>(Type: C, factory: Factory<C, P>, options?: ServeOptions): void;
	/** `host.references(Type)`: the references to objects of `Type` on this host (§19), for factories to derive from. */
	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, P>[]>;
}

/** What `host.serve` takes besides the type and the factory. */
export type ServeOptions = {
	/**
	 * How long, in milliseconds, a live object with params stays live after its last reference is released (0 by
	 * default): a reference within that time reuses it, with its documents and dependencies.
	 */
	readonly linger?: number;
};

/** A type a setup served: its contract, its factory and its options. */
export type ServedEntry = {
	readonly contract: Contract;
	readonly factory: ServedFactory;
	readonly options: ServeOptions;
};

/** A factory as a setup served it, of either kind (the host dispatches on its contract's kind). */
type ServedFactory = (params: never, principalOrSelf: never, self: never) => unknown;

/** A plugin's facet for hosts of the app's principal type `P` (type only: nothing is checked at runtime). */
export type Facet<P extends Principal> = {
	readonly setup: (host: FacetHost<P>) => void;
	/** Type only: the principal type, invariant, so a host takes only facets typed for exactly its `P`. */
	readonly "~principal"?: (principal: P) => P;
};

/** Defines a facet; base code binds `P` once, next to its principal type. */
export function defineFacet<P extends Principal>(setup: (host: FacetHost<P>) => void): Facet<P> {
	return { setup };
}

/** Runs a facet's setup and returns the types it served, in order; `references` is the host's. */
export function setUp<P extends Principal>(
	name: string,
	facet: Facet<P>,
	references: <C extends Contract>(Type: C) => Watchable<readonly Presence<C, P>[]>,
): readonly ServedEntry[] {
	const served: ServedEntry[] = [];
	let open = true;
	const host: FacetHost<P> = {
		serve: (Type, factory, options = {}) => {
			if (!open) throw new Error(`${name}: host.serve is valid only in the facet's setup`);
			// Served types are dispatched by name and kind; the factory matches its own contract.
			served.push({ contract: Type, factory: factory as ServedFactory, options });
		},
		references,
	};
	try {
		facet.setup(host);
	} finally {
		open = false;
	}
	return served;
}
