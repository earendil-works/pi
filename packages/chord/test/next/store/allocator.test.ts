// Tests of the id allocator (slice 6b D3, §1.2): from 2, raised by explicit ids, saturating at the safe range.

import { describe, expect, it } from "vitest";
import { FIRST_ID, IdAllocator } from "../../../src/next/store/allocator.ts";

describe("the allocator", () => {
	it("mints from its value, and an explicit id raises it above itself, never lowering it", () => {
		const ids = new IdAllocator(FIRST_ID);
		expect([ids.mint(), ids.mint()]).toEqual([2, 3]);
		ids.raise(100);
		expect(ids.mint()).toBe(101);
		ids.raise(50);
		expect(ids.value).toBe(102);
	});

	it("saturates at Number.MAX_SAFE_INTEGER: that id may be written, every later mint is refused", () => {
		const ids = new IdAllocator(Number.MAX_SAFE_INTEGER - 1);
		expect(ids.mint()).toBe(Number.MAX_SAFE_INTEGER - 1);
		expect(() => ids.mint()).toThrow("ID space is exhausted");
		ids.raise(Number.MAX_SAFE_INTEGER);
		expect(ids.value).toBe(Number.MAX_SAFE_INTEGER);
		expect(() => ids.mint()).toThrow("ID space is exhausted");
	});
});
