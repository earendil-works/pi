// `serveThing`: a kind's whole server side in one call: its data in `ThingKinds` and its hooks in `ThingHooks` (one
// host-lifetime object of the kind contributes both), and its remote object, one per thing and caller, admitted by
// the one admission (`admitThing`). The kind writes only `implement`: no admission, no table of who may.

import {
	type Contract,
	type Ctx,
	contribute,
	type FacetHost,
	type GrantableName,
	type Implementation,
	type P3Principal,
	type Self,
} from "@earendil-works/p3/v1";
import { admitThing } from "./admission.ts";
import { type ThingHook, ThingHooks } from "./contract.server.ts";
import type { Caller } from "./contract.ts";
import { type ThingKind, ThingKinds } from "./kind.ts";

/** What `implement` gets about its caller: who calls, and the members and flags granted. */
export type ThingCaller<C extends Contract> = {
	readonly caller: Caller;
	readonly granted: ReadonlySet<GrantableName<C>>;
};

/** A kind's server side: its object's members for one thing and caller, and its hooks. */
export type ThingImplementation<C extends Contract> = {
	/** The members of thing `thing` held in `workspace` for one caller; grantable state and events as builders. */
	readonly implement: (
		params: { readonly workspace: string; readonly thing: string },
		admitted: ThingCaller<C>,
		self: Self<P3Principal>,
	) => Implementation<C, Ctx<P3Principal>>;
	readonly create?: ThingHook["create"];
	readonly configure?: ThingHook["configure"];
	readonly delete?: ThingHook["delete"];
	/**
	 * The plugin's one thing of the kind, seeded in Pi once the kind is registered (any kind: `makers` says only who
	 * else makes more); server code reads its id through `OneThing`.
	 */
	readonly one?: ThingHook["one"];
};

/** Serves kind `Kind` on `host`: registers it with its hooks and serves its object with the one admission. */
export function serveThing<C extends Contract>(
	host: FacetHost<P3Principal>,
	Kind: ThingKind<C>,
	{ implement, ...hooks }: ThingImplementation<C>,
): void {
	contribute(host, `${Kind.name}.kind`, (self) => {
		self.contribute(ThingKinds, Kind.info);
		self.contribute(ThingHooks, { kind: Kind.name, ...hooks });
	});
	// The contract is `defineThing`'s: what Chord hands the factory as admitted is a `ThingCaller` (the things
	// admission's caller, `granted` a set of its names).
	const factory = (
		params: { readonly workspace: string; readonly thing: string },
		_principal: P3Principal,
		admitted: ThingCaller<C>,
		self: Self<P3Principal>,
	) => implement(params, admitted, self);
	// `C` is generic here: Chord's factory and option types cannot be resolved for it; `ThingImplementation` checks the
	// members against the contract at the call.
	(host.serve as (type: Contract, factory: unknown, options: unknown) => void)(Kind.contract, factory, {
		admit: admitThing(Kind),
	});
}
