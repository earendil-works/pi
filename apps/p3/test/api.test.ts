// The API module loads as plugins import it (by its package name, Chord from source) and names p3's host kinds.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineFacet, Session } from "@p3/app/v1";

describe("the API", () => {
	it("addresses a session by its id", () => {
		assert.equal(Session({ id: "s1" }).key, "session|s1");
	});

	it("defines a facet", () => {
		assert.equal(typeof defineFacet(() => {}), "object");
	});
});
