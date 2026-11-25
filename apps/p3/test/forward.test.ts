// Tests of `forward` (src/api/v1/forward.ts): a remote view's members filled from a store's reference, a local target
// refused by the types (review of slice 15, Sol 6).
import assert from "node:assert/strict";
import { it } from "node:test";
import { keyed, local, type Reference, str } from "@earendil-works/chord";
import { forward } from "../src/api/v1/forward.ts";

it("takes a remote view only: a local target, whose keyed members it would drop, does not type-check", () => {
	const Store = local("test.forward", { version: 1, params: {}, members: { rows: keyed(str()) } });
	const rows: Reference<typeof Store>["rows"] = {
		get: async () => undefined,
		watch: async () => undefined,
		at: () => {
			throw new Error("not used");
		},
	};
	// Never called: the check is the type error.
	// @ts-expect-error: a local contract is no view `forward` fills
	const forwarded = () => forward({ rows }, Store);
	assert.equal(typeof forwarded, "function");
});
