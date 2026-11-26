// `assertGranted`: asserts that a reference's binding granted members, and narrows it to have them (Chord slice 15:
// a grantable member is on the reference exactly while granted).

import assert from "node:assert/strict";
import type { With } from "@earendil-works/p3/v1";

/** Fails unless `ref`'s binding granted every one of `members`; after it, `ref` has them. */
export function assertGranted<R extends { readonly granted: ReadonlySet<string> }, const M extends keyof R & string>(
	ref: R,
	...members: readonly M[]
): asserts ref is With<R, M> {
	for (const member of members) assert.ok(ref.granted.has(member), `not granted ${member}`);
}
