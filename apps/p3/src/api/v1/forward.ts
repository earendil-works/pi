// `forward`: a view's members taken from a store's reference. Most remote objects own nothing: their factory gets a
// `local` store and hands its members on to its callers. The remote contract still lists those members explicitly;
// `forward` fills them from the same-named members of the store, so no member is written a second time.
// Browser-safe: the API module exports it.

import { type Contract, type Ctx, type Implementation, memberNames } from "@earendil-works/chord";
import type { P3Principal } from "../../principals.ts";

/** The members of the remote contract `C` as its factory returns them. */
type Served<C extends Contract> = Implementation<C, Ctx<P3Principal>>;

/**
 * The members of `Remote` for a factory to return: each member is `own`'s when it gives one (a member that needs the
 * caller, a grantable state or event member's builder), else the same-named member of `store` (a reference: its state
 * members follow it live, its methods are called with the caller's `ctx`).
 */
export function forward<
	C extends Contract,
	// The names of the members `own` gives; none without it, so `store` owes every member.
	K extends keyof Served<C> = never,
>(store: Omit<Served<C>, K>, Remote: C, own?: Pick<Served<C>, K>): Served<C> {
	const { state, methods, events } = memberNames(Remote);
	const members: Record<string, unknown> = {};
	for (const name of [...state, ...methods, ...events]) {
		// The types require `store` to have every member `own` does not give; a reference's members are own properties.
		members[name] = own !== undefined && Object.hasOwn(own, name) ? own[name as K] : store[name as never];
	}
	// The members are the contract's by construction (the names it lists).
	return members as Served<C>;
}
