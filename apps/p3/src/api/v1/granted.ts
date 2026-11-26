// `withGranted`: a reference typed with the grantable members its binding granted (Chord slice 15: such a member is on
// the reference exactly while granted, which TypeScript cannot see). Browser-safe: the API module exports it.

/** `R` with its grantable members `M` there. */
export type With<R, M extends keyof R> = R & { readonly [K in M]-?: NonNullable<R[K]> };

/** `ref` if its binding granted every one of `members`, else `undefined` (also for no reference). */
export function withGranted<R extends { readonly granted: ReadonlySet<string> }, const M extends keyof R & string>(
	ref: R | undefined,
	...members: readonly M[]
): With<R, M> | undefined {
	// The members are there exactly while granted (see above).
	return ref !== undefined && members.every((member) => ref.granted.has(member)) ? (ref as With<R, M>) : undefined;
}
