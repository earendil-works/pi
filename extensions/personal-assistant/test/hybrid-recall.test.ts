// rrfFuse — pure Reciprocal Rank Fusion helper for hybrid recall.
//
// Contract (from design.md Decision 2):
//   - Input: two rank arrays (dense KNN + BM25), each shaped `Array<{id: string}>`.
//     Only the array ORDER matters; raw scores are ignored.
//   - Contribution per rank: `1 / (rrfK + rank + 1)` — code uses 0-indexed rank,
//     so rank=0 → `1/(rrfK+1)`, rank=1 → `1/(rrfK+2)`. This matches RRF
//     literature which uses 1-indexed rank (rank=1 → `1/(rrfK+1)`).
//   - Same id appearing in both channels gets BOTH contributions added.
//   - Output: `Array<{id, rrfScore}>` sorted by `rrfScore` DESC (highest first).
//
// rrfFuse is a pure function (no I/O, no DB calls). It is exported so the
// search layer can call it from `recallAtoms` and the test suite can exercise
// the algorithm directly without spinning up an in-memory SQLite.

import { describe, expect, it } from "vitest";
import { rrfFuse } from "../search.ts";

describe("rrfFuse", () => {
	it("rrfFuse sums contributions from both channels", () => {
		// denseRanks = [a(0), b(1)]  →  a gets 1/(60+0+1)=1/61,  b gets 1/(60+1+1)=1/62
		// bm25Ranks  = [b(0), c(1)]  →  b gets 1/(60+0+1)=1/61,  c gets 1/(60+1+1)=1/62
		// final: a = 1/61,  b = 1/62 + 1/61,  c = 1/62
		const result = rrfFuse(
			[{ id: "a" }, { id: "b" }],
			[{ id: "b" }, { id: "c" }],
			60,
		);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("a")).toBeCloseTo(1 / 61, 9);
		// b appears at dense rank=1 and bm25 rank=0 → 1/62 + 1/61
		expect(byId.get("b")).toBeCloseTo(1 / 62 + 1 / 61, 9);
		expect(byId.get("c")).toBeCloseTo(1 / 62, 9);
		// Sort must be non-increasing.
		expect(result[0].id).toBe("b");
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it("rrfFuse with no overlap", () => {
		// Disjoint id sets → each id gets exactly one contribution.
		// denseRanks = [x(0), y(1)]  →  x=1/61,  y=1/62
		// bm25Ranks  = [p(0), q(1)]  →  p=1/61,  q=1/62
		const result = rrfFuse(
			[{ id: "x" }, { id: "y" }],
			[{ id: "p" }, { id: "q" }],
			60,
		);
		expect(result).toHaveLength(4);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("x")).toBeCloseTo(1 / 61, 9);
		expect(byId.get("y")).toBeCloseTo(1 / 62, 9);
		expect(byId.get("p")).toBeCloseTo(1 / 61, 9);
		expect(byId.get("q")).toBeCloseTo(1 / 62, 9);
		// x and p are tied at 1/61; y and q are tied at 1/62.
		// Sort must be non-increasing.
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it("rrfFuse with full overlap", () => {
		// Same 2 ids in both channels at the same ranks → each id gets
		// BOTH contributions summed (i.e. its rrfScore is exactly 2x what
		// it would be from a single channel).
		// denseRanks = [a(0), b(1)]  →  a=1/61,  b=1/62
		// bm25Ranks  = [a(0), b(1)]  →  a=1/61,  b=1/62
		// final: a = 1/61 + 1/61,  b = 1/62 + 1/62
		const result = rrfFuse(
			[{ id: "a" }, { id: "b" }],
			[{ id: "a" }, { id: "b" }],
			60,
		);
		expect(result).toHaveLength(2);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		// a is at rank=0 in both channels → 1/61 + 1/61
		expect(byId.get("a")).toBeCloseTo(1 / 61 + 1 / 61, 9);
		// b is at rank=1 in both channels → 1/62 + 1/62
		expect(byId.get("b")).toBeCloseTo(1 / 62 + 1 / 62, 9);
		// a must outrank b.
		expect(result[0].id).toBe("a");
	});

	it("rrfFuse ranks by fused score descending", () => {
		// Mix overlap patterns to produce a known ordering.
		// denseRanks = [a(0), b(1), c(2)]  →  a=1/61,  b=1/62,  c=1/63
		// bm25Ranks  = [a(0), d(1), e(2)]  →  a=1/61,  d=1/62,  e=1/63
		// fused: a = 1/61 + 1/61 ≈ 0.0328  (double-channel, rank 0)
		//        b = 1/62                ≈ 0.0161  (dense only)
		//        c = 1/63                ≈ 0.0159  (dense only)
		//        d = 1/62                ≈ 0.0161  (bm25 only)
		//        e = 1/63                ≈ 0.0159  (bm25 only)
		// So `a` sorts first (double-channel), then b/d tied at 1/62, then
		// c/e tied at 1/63.
		const result = rrfFuse(
			[{ id: "a" }, { id: "b" }, { id: "c" }],
			[{ id: "a" }, { id: "d" }, { id: "e" }],
			60,
		);
		expect(result).toHaveLength(5);
		// a must be first (only id with both-channel contribution at rank=0).
		expect(result[0].id).toBe("a");
		expect(result[0].rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 9);
		// Sort is non-increasing across the whole list.
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
		// Verify each id's exact fused score.
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("b")).toBeCloseTo(1 / 62, 9);
		expect(byId.get("c")).toBeCloseTo(1 / 63, 9);
		expect(byId.get("d")).toBeCloseTo(1 / 62, 9);
		expect(byId.get("e")).toBeCloseTo(1 / 63, 9);
	});

	it("rrfFuse k=0 collapses to rank-weighted sum", () => {
		// k=0 → contribution is 1/(0 + rank + 1) = 1/(rank+1) — harmonic.
		// denseRanks = [A(0), B(1), C(2)]  →  A=1/1,  B=1/2,  C=1/3
		// bm25Ranks  = [C(0), D(1)]        →  C=1/1,  D=1/2
		// fused: A = 1/1 = 1.0
		//        B = 1/2 = 0.5
		//        C = 1/3 + 1/1 = 4/3 ≈ 1.333
		//        D = 1/2 = 0.5
		const result = rrfFuse(
			[{ id: "A" }, { id: "B" }, { id: "C" }],
			[{ id: "C" }, { id: "D" }],
			0,
		);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		// A: dense rank=0 only → 1/1
		expect(byId.get("A")).toBeCloseTo(1, 9);
		// B: dense rank=1 only → 1/2
		expect(byId.get("B")).toBeCloseTo(0.5, 9);
		// C: dense rank=2 + bm25 rank=0 → 1/3 + 1/1
		expect(byId.get("C")).toBeCloseTo(1 / 3 + 1, 9);
		// D: bm25 rank=1 only → 1/2
		expect(byId.get("D")).toBeCloseTo(0.5, 9);
		// Sort: C (1.333) > A (1.0) > B = D (0.5).
		expect(result[0].id).toBe("C");
		expect(result[1].id).toBe("A");
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it("rrfFuse handles empty channels", () => {
		// Both empty → returns [].
		const emptyBoth = rrfFuse([], [], 60);
		expect(emptyBoth).toEqual([]);

		// Dense empty, bm25 populated → each bm25 id gets one contribution.
		const denseEmpty = rrfFuse(
			[],
			[{ id: "p" }, { id: "q" }, { id: "r" }],
			60,
		);
		expect(denseEmpty).toHaveLength(3);
		const deById = new Map(denseEmpty.map((r) => [r.id, r.rrfScore]));
		expect(deById.get("p")).toBeCloseTo(1 / 61, 9);
		expect(deById.get("q")).toBeCloseTo(1 / 62, 9);
		expect(deById.get("r")).toBeCloseTo(1 / 63, 9);

		// Bm25 empty, dense populated → each dense id gets one contribution.
		const bm25Empty = rrfFuse(
			[{ id: "x" }, { id: "y" }, { id: "z" }],
			[],
			60,
		);
		expect(bm25Empty).toHaveLength(3);
		const beById = new Map(bm25Empty.map((r) => [r.id, r.rrfScore]));
		expect(beById.get("x")).toBeCloseTo(1 / 61, 9);
		expect(beById.get("y")).toBeCloseTo(1 / 62, 9);
		expect(beById.get("z")).toBeCloseTo(1 / 63, 9);
	});
});
