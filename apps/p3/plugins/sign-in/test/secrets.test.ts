// The sign-in plugin's tokens (`secrets.ts`): random base64url, kept as SHA-256 hashes, matched in constant time.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashToken, matchesHash, newToken } from "../secrets.ts";

describe("tokens", () => {
	it("are random base64url of their bytes, kept as their SHA-256 hash, and matched only by themselves", () => {
		const [one, other] = [newToken(), newToken()];
		assert.match(one, /^[A-Za-z0-9_-]{43}$/);
		assert.match(newToken(12), /^[A-Za-z0-9_-]{16}$/);
		assert.notEqual(one, other);
		assert.match(hashToken(one), /^[0-9a-f]{64}$/);
		assert.notEqual(hashToken(one), one);
		assert.deepEqual(
			[matchesHash(one, hashToken(one)), matchesHash(other, hashToken(one)), matchesHash(one, "")],
			[true, false, false],
		);
		// A stored hash that is no hex of the right length never matches.
		assert.equal(matchesHash(one, hashToken(one).slice(2)), false);
	});
});
