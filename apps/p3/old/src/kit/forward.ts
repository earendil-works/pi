// `forward`: a view's members taken from a store's reference. Most remote objects own nothing: their factory gets a
// `local` store and hands its members on to one audience. The remote contract still lists that audience's members
// explicitly; `forward` fills them from the same-named members of the store, so no member is written a second time.
// Browser-safe: the API module exports it.

import { type Contract, type Ctx, type Implementation, memberNames } from "@earendil-works/chord";
import type { P3Principal } from "../principals.ts";

/** One variant of the remote contract `C` as its factory returns it. */
type Served<C extends Contract, V extends string> = Extract<
	Implementation<C, Ctx<P3Principal>>,
	{ readonly variant: V }
>;

/** The names of a remote contract's variants. */
type VariantOf<C extends Contract> = Extract<Implementation<C>, { readonly variant: string }>["variant"];

/**
 * `variant` of `Remote` for a factory to return: each member is `own`'s when it gives one (a member that needs the
 * caller), else the same-named member of `store` (a reference: its state members follow it live, its methods are
 * called with the caller's `ctx`).
 */
export function forward<
	C extends Contract,
	V extends VariantOf<C>,
	// The names of the members `own` gives; none without it, so `store` owes every member.
	K extends keyof Served<C, V>["members"] = never,
>(
	store: Omit<Served<C, V>["members"], K>,
	Remote: C,
	variant: V,
	own?: Pick<Served<C, V>["members"], K>,
): Served<C, V> {
	const { state, methods, events } = memberNames(Remote, variant);
	const members: Record<string, unknown> = {};
	for (const name of [...state, ...methods, ...events]) {
		// The types require `store` to have every member `own` does not give; a reference's members are own properties.
		members[name] = own !== undefined && Object.hasOwn(own, name) ? own[name as K] : store[name as never];
	}
	// The members are the variant's by construction (the names its contract lists).
	return { variant, members } as Served<C, V>;
}
