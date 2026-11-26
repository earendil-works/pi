// A terminal's output ring: it keeps exactly the last `capacity` bytes, whether they came in one write larger than it
// or in many small ones across its end; reads start at the oldest byte kept when asked for older ones, and copy.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Ring } from "../ring.ts";

/** `length` bytes counting up from `from` (mod 256). */
function counting(from: number, length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (from + i) % 256);
}

describe("the output ring", () => {
	it("keeps the last bytes of one write larger than it, and of a full ring and one more byte", () => {
		const big = new Ring(8);
		big.write(counting(0, 9));
		assert.deepEqual([big.start, big.end], [1, 9]);
		assert.deepEqual(big.read(0, 100), counting(1, 8));
		const full = new Ring(8);
		full.write(counting(0, 8));
		full.write(counting(8, 1));
		assert.deepEqual(full.read(0, 100), counting(1, 8));
	});

	it("wraps small writes across its end and reads any part of what it keeps", () => {
		const ring = new Ring(8);
		for (let at = 0; at < 30; at += 3) ring.write(counting(at, 3));
		assert.deepEqual([ring.start, ring.end], [22, 30]);
		assert.deepEqual(ring.read(25, 2), counting(25, 2));
		assert.deepEqual(ring.read(30, 2), new Uint8Array());
		const copy = ring.read(22, 8);
		ring.write(counting(30, 8));
		assert.deepEqual(copy, counting(22, 8), "a read is a copy");
	});
});
