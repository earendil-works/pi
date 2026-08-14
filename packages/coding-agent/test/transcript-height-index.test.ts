import { describe, expect, it } from "vitest";
import { TranscriptHeightIndex } from "../src/modes/interactive/transcript-height-index.ts";

function total(heights: readonly number[]): number {
	return heights.reduce((sum, height) => sum + height, 0);
}

function prefixSum(heights: readonly number[], endExclusive: number): number {
	let sum = 0;
	for (let index = 0; index < endExclusive; index++) {
		sum += heights[index] ?? 0;
	}
	return sum;
}

function blockAtRow(heights: readonly number[], row: number): number {
	let prefix = 0;
	for (let index = 0; index < heights.length; index++) {
		prefix += heights[index] ?? 0;
		if (prefix > row) {
			return index;
		}
	}
	return heights.length;
}

function observableState(index: TranscriptHeightIndex): { heights: number[]; total: number } {
	const heights: number[] = [];
	for (let blockIndex = 0; blockIndex < index.length; blockIndex++) {
		heights.push(index.prefixSum(blockIndex + 1) - index.prefixSum(blockIndex));
	}
	return { heights, total: index.total };
}

function expectMatchesNaive(index: TranscriptHeightIndex, heights: readonly number[]): void {
	const expectedTotal = total(heights);
	expect(index.length).toBe(heights.length);
	expect(index.total).toBe(expectedTotal);
	for (let endExclusive = 0; endExclusive <= heights.length; endExclusive++) {
		expect(index.prefixSum(endExclusive)).toBe(prefixSum(heights, endExclusive));
	}
	for (let row = 0; row <= expectedTotal + 2; row++) {
		expect(index.blockAtRow(row)).toBe(blockAtRow(heights, row));
	}
}

function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

describe("TranscriptHeightIndex", () => {
	it("maps exact prefix heights and rows across zero-height blocks", () => {
		const index = new TranscriptHeightIndex([2, 0, 3, 0]);

		expect(index.length).toBe(4);
		expect(index.total).toBe(5);
		expect([0, 1, 2, 3, 4].map((end) => index.prefixSum(end))).toEqual([0, 2, 2, 5, 5]);
		expect([0, 1, 2, 3, 4, 5, 20].map((row) => index.blockAtRow(row))).toEqual([0, 0, 2, 2, 2, 4, 4]);
	});

	it("supports replace, append, and point update at Fenwick boundaries", () => {
		const index = new TranscriptHeightIndex();
		const heights: number[] = [];

		for (const height of [1, 0, 2, 3, 0, 4, 1, 5]) {
			index.append(height);
			heights.push(height);
			expectMatchesNaive(index, heights);
		}

		index.update(3, 0);
		heights[3] = 0;
		index.update(4, 7);
		heights[4] = 7;
		expectMatchesNaive(index, heights);

		index.replace([0, 6, 0, 1]);
		expectMatchesNaive(index, [0, 6, 0, 1]);
		index.replace([]);
		expectMatchesNaive(index, []);
	});

	it("truncates suffixes without changing retained Fenwick prefixes", () => {
		const index = new TranscriptHeightIndex([1, 0, 2, 3, 0, 4, 1, 5]);
		index.truncate(5);
		expectMatchesNaive(index, [1, 0, 2, 3, 0]);
		index.append(7);
		expectMatchesNaive(index, [1, 0, 2, 3, 0, 7]);
		index.truncate(0);
		expectMatchesNaive(index, []);
		expect(() => index.truncate(1)).toThrow(RangeError);
	});

	it("applies multi-block height changes atomically", () => {
		const index = new TranscriptHeightIndex([2, 4, 6, 8]);
		index.updateMany([
			{ index: 0, height: 7 },
			{ index: 2, height: 0 },
			{ index: 3, height: 3 },
		]);
		expectMatchesNaive(index, [7, 4, 0, 3]);

		const before = observableState(index);
		expect(() =>
			index.updateMany([
				{ index: 1, height: 9 },
				{ index: 4, height: 1 },
			]),
		).toThrow(RangeError);
		expect(observableState(index)).toEqual(before);
		expect(() =>
			index.updateMany([
				{ index: 1, height: 9 },
				{ index: 1, height: 10 },
			]),
		).toThrow(/Duplicate/);
		expect(observableState(index)).toEqual(before);
	});

	it("leaves all observable state unchanged when a mutation fails", () => {
		const invalidHeights = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
		const index = new TranscriptHeightIndex([2, 0, 4]);

		for (const invalidHeight of invalidHeights) {
			const before = observableState(index);
			expect(() => index.replace([7, 8, invalidHeight])).toThrow(RangeError);
			expect(observableState(index)).toEqual(before);
			expect(() => index.append(invalidHeight)).toThrow(RangeError);
			expect(observableState(index)).toEqual(before);
			expect(() => index.update(1, invalidHeight)).toThrow(RangeError);
			expect(observableState(index)).toEqual(before);
		}

		for (const invalidIndex of [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const before = observableState(index);
			expect(() => index.update(invalidIndex, 1)).toThrow(RangeError);
			expect(observableState(index)).toEqual(before);
		}
	});

	it("rejects unsafe totals transactionally", () => {
		const max = Number.MAX_SAFE_INTEGER;
		const index = new TranscriptHeightIndex([max - 2, 2]);

		expect(index.total).toBe(max);
		expect(index.prefixSum(1)).toBe(max - 2);
		expect(index.blockAtRow(max - 3)).toBe(0);
		expect(index.blockAtRow(max - 2)).toBe(1);
		expect(index.blockAtRow(max - 1)).toBe(1);
		expect(index.blockAtRow(max)).toBe(2);
		const before = observableState(index);
		expect(() => index.replace([max, 1])).toThrow(RangeError);
		expect(observableState(index)).toEqual(before);
		expect(() => index.append(1)).toThrow(RangeError);
		expect(observableState(index)).toEqual(before);
		expect(() => index.update(0, max)).toThrow(RangeError);
		expect(observableState(index)).toEqual(before);
		expect(() => new TranscriptHeightIndex([max + 1])).toThrow(RangeError);
	});

	it("rejects invalid prefix and row queries", () => {
		const index = new TranscriptHeightIndex([1, 2]);

		for (const end of [-1, 3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => index.prefixSum(end)).toThrow(RangeError);
		}
		for (const row of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => index.blockAtRow(row)).toThrow(RangeError);
		}
	});

	it("matches naive arrays through seeded randomized operation sequences", () => {
		const seeds = [1, 0x12345678, 0x9e3779b9, 0xdeadbeef, 0xcafebabe, 0xffffffff];

		for (const seed of seeds) {
			const random = createRandom(seed);
			const heights: number[] = [];
			const index = new TranscriptHeightIndex();

			for (let step = 0; step < 750; step++) {
				const operation = random() % 5;
				if (operation === 0) {
					const nextLength = random() % 40;
					const replacement = Array.from({ length: nextLength }, () => random() % 9);
					index.replace(replacement);
					heights.splice(0, heights.length, ...replacement);
				} else if (operation === 1 && heights.length < 80) {
					const height = random() % 9;
					index.append(height);
					heights.push(height);
				} else if (operation === 2 && heights.length > 0) {
					const blockIndex = random() % heights.length;
					const height = random() % 9;
					index.update(blockIndex, height);
					heights[blockIndex] = height;
				} else {
					const endExclusive = random() % (heights.length + 1);
					expect(index.prefixSum(endExclusive)).toBe(prefixSum(heights, endExclusive));
					const row = random() % (total(heights) + 4);
					expect(index.blockAtRow(row)).toBe(blockAtRow(heights, row));
				}

				expect(index.length).toBe(heights.length);
				expect(index.total).toBe(total(heights));
				if (step % 41 === 0) {
					expectMatchesNaive(index, heights);
				}
			}
			expectMatchesNaive(index, heights);
		}
	});

	it("rejects seeded randomized invalid heights without changing state", () => {
		const invalidHeights = [-1, -100, 0.25, 12.75, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
		const random = createRandom(0xa11ce);
		const heights = Array.from({ length: 30 }, () => random() % 20);
		const index = new TranscriptHeightIndex(heights);

		for (let iteration = 0; iteration < 200; iteration++) {
			const invalidHeight = invalidHeights[random() % invalidHeights.length] ?? Number.NaN;
			const before = observableState(index);
			const replacement = Array.from({ length: 20 }, () => random() % 20);
			replacement[random() % replacement.length] = invalidHeight;
			expect(() => index.replace(replacement)).toThrow(RangeError);
			expect(observableState(index)).toEqual(before);

			if (random() % 2 === 0) {
				expect(() => index.append(invalidHeight)).toThrow(RangeError);
			} else {
				expect(() => index.update(random() % index.length, invalidHeight)).toThrow(RangeError);
			}
			expect(observableState(index)).toEqual(before);
		}
	});
});
