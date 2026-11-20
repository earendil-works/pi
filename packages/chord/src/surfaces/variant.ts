// A remote reference as a UI reads it in one variant (decision "C15 stands; the UI bindings follow the variant"): the
// reference narrowed to that variant while it is live in it, nothing otherwise. What React's `useVariant` and the TUI
// scope's `variant` return, each with its own subscription to the reference's state: a held reference's variant is
// `undefined` until it binds and changes while it is held (an admission's other allowed value binds another variant),
// and it keeps its last variant while it loads, so the comparison alone would leave an editor's controls up for a
// reader. References themselves get no such helper (C15): plain code compares `ref.variant`.

import type { RefState } from "../host/index.ts";
import type { NativeWatchable } from "../watch.ts";

/** A reference to a remote contract, held or got: its state and the variant it is bound in. */
export type VariantRef = { readonly state: NativeWatchable<RefState>; readonly variant: string | undefined };

/** The variants `R` can be bound in. */
export type VariantOf<R extends VariantRef> = R extends { readonly variant: infer V } ? Exclude<V, undefined> : never;

/** `R` bound in variant `V`: that variant's members, `variant` narrowed to it. */
export type InVariant<R extends VariantRef, V extends string> = Extract<R, { readonly variant: V | undefined }> & {
	readonly variant: V;
};

/**
 * `ref` when it is live and bound in `variant`, else `undefined`: no reference, loading (also between two variants),
 * failed (denied too), ended, or another variant. True of the moment it is read: no guarantee across an `await`.
 */
export function liveIn<R extends VariantRef, const V extends VariantOf<R>>(
	ref: R | undefined,
	variant: V,
): InVariant<R, V> | undefined {
	// `variant` throws on a released reference: read only while live.
	if (ref === undefined || ref.state.value.kind !== "live" || ref.variant !== variant) return undefined;
	// The discriminant was compared: TypeScript cannot narrow a generic union by it.
	return ref as InVariant<R, V>;
}
