// The rules of MCP leases, as pure functions over the lease list: a session worker sets the locations it works at for
// its generation (a newer generation takes the session over, an older one is refused), its calls go through the lease
// at a location only from the incarnation that set it, and its view's end releases its generation's leases.

import { type Location, sameLocation } from "@p2/app/v1";

/** The project configuration at a location as the worker read it: none, the file's text, or why it could not. */
export type ProjectSource =
	| { readonly kind: "none" }
	| { readonly kind: "file"; readonly text: string }
	| { readonly kind: "unreadable"; readonly error: string };

/**
 * A session worker's lease on the servers at one location, from the generation and incarnation that set it, with the
 * project configuration found there.
 */
export type Lease = {
	readonly session: string;
	readonly location: Location;
	readonly project: ProjectSource;
	readonly generation: number;
	readonly incarnation: string;
};

/** A location to lease, with its project configuration. */
export type LeasePlace = { readonly location: Location; readonly project: ProjectSource };

/** Who asks: one incarnation of one generation of a session's worker. */
export type LeaseCaller = { readonly session: string; readonly generation: number; readonly incarnation: string };

/** `setLocations`'s outcome: the new lease list, or why the caller may not set it. */
export type LeasesSet =
	| { readonly kind: "set"; readonly leases: Lease[] }
	| { readonly kind: "refused"; readonly reason: string };

/** The lease `call` goes through: held by the caller, none at that location, or another incarnation's. */
export type LeaseHeld =
	| { readonly kind: "held"; readonly lease: Lease }
	| { readonly kind: "none" }
	| { readonly kind: "stale" };

/**
 * `caller`'s session leases exactly `places` from now on, for `caller`'s generation and incarnation (of a location
 * given twice, the first counts): its leases elsewhere end, those of older generations (a worker that is gone) are
 * taken over. A newer generation's lease refuses.
 */
export function setLocations(leases: readonly Lease[], caller: LeaseCaller, places: readonly LeasePlace[]): LeasesSet {
	const own = leases.filter((lease) => lease.session === caller.session);
	if (own.some((lease) => lease.generation > caller.generation))
		return { kind: "refused", reason: "A newer worker of this session holds its MCP servers" };
	const { session, generation, incarnation } = caller;
	const wanted = places.filter(
		(place, index) => places.findIndex((other) => sameLocation(other.location, place.location)) === index,
	);
	return {
		kind: "set",
		leases: [
			...leases.filter((lease) => lease.session !== session),
			...wanted.map(({ location, project }) => ({ session, location, project, generation, incarnation })),
		],
	};
}

/** The lease `caller` calls through at `location`. */
export function heldLease(leases: readonly Lease[], caller: LeaseCaller, location: Location): LeaseHeld {
	const lease = leases.find(
		(candidate) => candidate.session === caller.session && sameLocation(candidate.location, location),
	);
	if (lease === undefined) return { kind: "none" };
	return lease.incarnation === caller.incarnation && lease.generation === caller.generation
		? { kind: "held", lease }
		: { kind: "stale" };
}

/** `leases` without those of `session`'s `generation` (its view ended). */
export function releaseGeneration(leases: readonly Lease[], session: string, generation: number): Lease[] {
	return leases.filter((lease) => lease.session !== session || lease.generation !== generation);
}
