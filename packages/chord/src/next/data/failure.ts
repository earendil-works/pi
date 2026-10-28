// Failure causes of an open: transient (retry later) or broken (bad configuration). The failing stage decides.

import { asChordError, type ChordError } from "./errors.ts";

/** Why an open failed; the kind comes from the failing stage, never from the error code. */
export type FailureCause =
	| { readonly kind: "transient"; readonly error: ChordError }
	| { readonly kind: "broken"; readonly error: ChordError };

/** Marks an open's failure as broken (bad configuration): `throw broken(error)`. */
export function broken(cause: unknown): Error {
	return new BrokenOpen(cause);
}

/** The cause of a value thrown by an open: broken when it came from `broken()`, transient otherwise. */
export function openFailure(thrown: unknown, label: string): FailureCause {
	if (thrown instanceof BrokenOpen) return { kind: "broken", error: asChordError(thrown.cause, label) };
	return { kind: "transient", error: asChordError(thrown, label) };
}

class BrokenOpen extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "BrokenOpen";
	}
}
