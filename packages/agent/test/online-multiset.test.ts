import { describe, expect, it } from "vitest";
import { OnlineMultiset } from "../src/online-multiset.ts";

describe("OnlineMultiset", () => {
	it("maintains duplicates, lower medians, and one-indexed ranks", () => {
		const multiset = new OnlineMultiset();

		for (const value of [5, 1, 5, -2, 9]) multiset.add(value);

		expect(multiset.size).toBe(5);
		expect(multiset.kth(1)).toBe(-2);
		expect(multiset.kth(3)).toBe(5);
		expect(multiset.median()).toBe(5);
		expect(multiset.del(5)).toBe(true);
		expect(multiset.median()).toBe(1);
		expect(multiset.kth(3)).toBe(5);
	});

	it("uses undefined for empty or out-of-range queries and leaves a missing delete unchanged", () => {
		const multiset = new OnlineMultiset();

		expect(multiset.median()).toBeUndefined();
		expect(multiset.kth(0)).toBeUndefined();
		expect(multiset.kth(1)).toBeUndefined();
		expect(multiset.del(10)).toBe(false);
		multiset.add(-1_000_000_000);
		multiset.add(1_000_000_000);
		expect(multiset.median()).toBe(-1_000_000_000);
		expect(multiset.kth(2)).toBe(1_000_000_000);
		expect(multiset.kth(3)).toBeUndefined();
	});

	it("matches a sorted-array oracle across deterministic online operations", () => {
		const multiset = new OnlineMultiset();
		const oracle: number[] = [];
		let state = 0x1234_5678;
		const next = (): number => {
			state = (state * 1_664_525 + 1_013_904_223) >>> 0;
			return state;
		};

		for (let index = 0; index < 2_000; index++) {
			const value = (next() % 101) - 50;
			if ((next() & 3) !== 0) {
				multiset.add(value);
				oracle.push(value);
				oracle.sort((left, right) => left - right);
			} else {
				const position = oracle.indexOf(value);
				expect(multiset.del(value)).toBe(position !== -1);
				if (position !== -1) oracle.splice(position, 1);
			}

			expect(multiset.size).toBe(oracle.length);
			expect(multiset.median()).toBe(oracle[Math.floor((oracle.length - 1) / 2)]);
			const rank = (next() % (oracle.length + 2)) + 1;
			expect(multiset.kth(rank)).toBe(oracle[rank - 1]);
		}
	});

	it("handles the 200,000-operation online constraint without preprocessing", () => {
		const multiset = new OnlineMultiset();

		for (let value = 200_000; value >= 1; value--) multiset.add(value);

		expect(multiset.size).toBe(200_000);
		expect(multiset.kth(1)).toBe(1);
		expect(multiset.kth(200_000)).toBe(200_000);
		expect(multiset.median()).toBe(100_000);

		for (let value = 2; value <= 200_000; value += 2) expect(multiset.del(value)).toBe(true);

		expect(multiset.size).toBe(100_000);
		expect(multiset.kth(50_000)).toBe(99_999);
		expect(multiset.median()).toBe(99_999);
	});
});
