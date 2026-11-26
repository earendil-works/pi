// A terminal's output ring: it keeps exactly the last `capacity` bytes, whether they came in one write larger than it
// or in many small ones across its end; reads start at the oldest byte kept when asked for older ones, and copy; its
// buffer starts small and grows only with what was written (astra and opus round 3).

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

	it("starts small and grows with the output, keeping every byte, up to its capacity, then wraps", () => {
		const ring = new Ring(64 * 1024);
		assert.equal(ring.size, 0);
		ring.write(counting(0, 1));
		assert.equal(ring.size, 4 * 1024, "one byte costs the first size");
		let written = 1;
		for (const length of [5000, 10_000, 30_000, 40_000]) {
			ring.write(counting(written, length));
			written += length;
		}
		assert.equal(ring.size, 64 * 1024);
		assert.deepEqual([ring.start, ring.end], [written - 64 * 1024, written]);
		assert.deepEqual(ring.read(0, 64 * 1024), counting(written - 64 * 1024, 64 * 1024));
	});
});
