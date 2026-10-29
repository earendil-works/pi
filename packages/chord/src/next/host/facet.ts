// Facets (§16): a plugin's setup for one host, typed by the app's principal type. A setup only declares: the types and
// registries it serves, its contributions to registries (slice 8) and the host's presence lists; it has no documents,
// routines or natives, so a facet cannot fail after `load`.

import type { Watchable } from "../../watch.ts";
import type { Contract } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Contribution, Registry, RegistryProvider } from "../registries/index.ts";
import type { Factory } from "./attempt.ts";
import type { Presence } from "./presence.ts";

/** What a setup serves types and registries with (valid only while the setup runs), and the host's presence lists. */
export interface FacetHost<P extends Principal = Principal> {
	/** Serves a type on this host with `factory`; a remote type's factory gets the principal its object is for. */
	serve<C extends Contract>(Type: C, factory: Factory<C, P>, options?: ServeOptions): void;
	/**
	 * Serves registry `R` on this host (its defining plugin's facet, the one provider, D1): `compose` builds the value
	 * from the table, `accepts` adapts older versions. A second serve of a registry is refused at `load`.
	 */
	serve<C, V>(R: Registry<C, V>, provider: RegistryProvider<C, V>): void;
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

/** What a facet's setup declares with besides the host: its contributions to registries (R21). */
export interface FacetSelf {
	/**
	 * Contributes `value` to registry `R` while this plugin is loaded: a plain value, or a Chord watchable of one
	 * (followed: its change recomposes). At most one per registry.
	 */
	contribute<C>(R: Registry<C, unknown>, value: Contribution<C>): void;
}

/** What a setup served, by kind: a type (its contract, factory and options), or a registry (its provider). */
export type ServedEntry =
	| {
			readonly kind: "type";
			readonly contract: Contract;
			readonly factory: ServedFactory;
			readonly options: ServeOptions;
	  }
	| {
			readonly kind: "registry";
			readonly registry: Registry<unknown, unknown>;
			readonly provider: RegistryProvider<unknown, unknown>;
	  };

/** A contribution a setup declared. */
export type FacetContribution = { readonly registry: Registry<unknown, unknown>; readonly value: unknown };

/** A factory as a setup served it, of either kind (the host dispatches on its contract's kind). */
type ServedFactory = (params: never, principalOrSelf: never, self: never) => unknown;

/** A plugin's facet for hosts of the app's principal type `P` (type only: nothing is checked at runtime). */
export type Facet<P extends Principal> = {
	readonly setup: (host: FacetHost<P>, self: FacetSelf) => void;
	/** Type only: the principal type, invariant, so a host takes only facets typed for exactly its `P`. */
	readonly "~principal"?: (principal: P) => P;
};

/** Defines a facet; base code binds `P` once, next to its principal type. */
export function defineFacet<P extends Principal>(setup: (host: FacetHost<P>, self: FacetSelf) => void): Facet<P> {
	return { setup };
}

/**
 * Runs a facet's setup and returns the types and registries it served and its contributions, in order; `references`
 * is the host's.
 */
export function setUp<P extends Principal>(
	name: string,
	facet: Facet<P>,
	references: <C extends Contract>(Type: C) => Watchable<readonly Presence<C, P>[]>,
): { readonly served: readonly ServedEntry[]; readonly contributions: readonly FacetContribution[] } {
	const served: ServedEntry[] = [];
	const contributions: FacetContribution[] = [];
	let open = true;
	const assertOpen = (what: string): void => {
		if (!open) throw new Error(`${name}: ${what} is valid only in the facet's setup`);
	};
	const host: FacetHost<P> = {
		serve: (Type: Contract | Registry<unknown, unknown>, implementation: unknown, options: ServeOptions = {}) => {
			assertOpen("host.serve");
			// Served types and registries are dispatched by their kind; a factory matches its own contract, a provider
			// its own registry.
			if (Type.kind === "registry") {
				served.push({
					kind: "registry",
					registry: Type,
					provider: implementation as RegistryProvider<unknown, unknown>,
				});
			} else {
				served.push({ kind: "type", contract: Type, factory: implementation as ServedFactory, options });
			}
		},
		references,
	};
	const self: FacetSelf = {
		contribute: (registry, value) => {
			assertOpen("self.contribute");
			if (contributions.some((each) => each.registry.name === registry.name)) {
				throw new Error(`${name}: registry ${registry.name} is contributed to twice`);
			}
			contributions.push({ registry: registry as Registry<unknown, unknown>, value });
		},
	};
	try {
		facet.setup(host, self);
	} finally {
		open = false;
	}
	return { served, contributions };
}
