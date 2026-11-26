// Tests of plain JSON kept and compared without text (`plain-json.ts`): equal exactly when canonical JSON's texts are
// (random plain values and their remixes: other objects, keys in another order, -0 for 0), with a skipped key; copies
// that are Chord's own (other objects, an own `__proto__` key kept, later changes of the original not seen); a
// comparison of equal values allocates no text (cost guard).

import { GCProfiler, getHeapStatistics } from "node:v8";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { canonicalJson, copyJson, sameJson } from "../../src/data/internal.ts";

const text = (value: unknown) => canonicalJson(value as never, BACKGROUND_CONTEXT);

/** A seeded generator of numbers in [0, 1). */
function seeded(seed: number): () => number {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
}

/** A random plain value of few distinct parts (fields maybe `undefined`, as plugin code writes them). */
function random(next: () => number, depth: number): unknown {
	const tokens = [0, -0, 1, "a", "", true, false, null, "b"];
	const pick = Math.floor(next() * (tokens.length + (depth > 2 ? 0 : 2)));
	if (pick < tokens.length) return tokens[pick];
	if (pick === tokens.length) return Array.from({ length: Math.floor(next() * 3) }, () => random(next, depth + 1));
	const object: Record<string, unknown> = {};
	for (const key of ["a", "b", "granted"]) {
		if (next() < 0.5) object[key] = next() < 0.1 ? undefined : random(next, depth + 1);
	}
	return object;
}

/** `value` built again: other objects, keys in another order, 0 and -0 swapped. */
function remix(value: unknown, next: () => number): unknown {
	if (Object.is(value, 0) || Object.is(value, -0)) return next() < 0.5 ? 0 : -0;
	if (Array.isArray(value)) return value.map((item) => remix(item, next));
	if (typeof value !== "object" || value === null) return value;
	const fields = value as Record<string, unknown>;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(fields).sort(() => next() - 0.5)) copy[key] = remix(fields[key], next);
	return copy;
}

describe("sameJson", () => {
	it("is equal exactly when canonical JSON's texts are, with and without a skipped key (20,000 random pairs)", () => {
		const next = seeded(7);
		const object = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
		const omit = (value: unknown) => {
			const { granted: _, ...rest } = value as Record<string, unknown>;
			return rest;
		};
		let equal = 0;
		for (let round = 0; round < 20_000; round++) {
			const a = random(next, 0);
			const b = next() < 0.6 ? remix(a, next) : random(next, 0);
			const same = text(a) === text(b);
			expect([round, sameJson(copyJson(a), b)]).toEqual([round, same]);
			if (same) equal++;
			if (object(a) && object(b)) {
				const skipped = text(omit(a)) === text(omit(b));
				expect([round, sameJson(copyJson(a), b, "granted")]).toEqual([round, skipped]);
			}
		}
		expect(equal).toBeGreaterThan(5_000);
	});

	it("tells a missing field from an undefined one, an object from a list, and -0 from nothing but 0", () => {
		expect([
			sameJson({}, { a: undefined }),
			sameJson({ a: undefined }, { a: undefined }),
			sameJson({}, []),
			sameJson([[1, { b: -0 }]], [[1, { b: 0 }]]),
			sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }),
		]).toEqual([false, true, false, true, true]);
	});

	it("makes no text for equal values of other objects (cost guard)", () => {
		const a = copyJson({ mode: "write", level: 3, tags: ["x", "y"], nested: { on: true, at: [1, 2, 3] } });
		const b = { nested: { at: [1, 2, 3], on: true }, tags: ["x", "y"], level: 3, mode: "write" };
		for (let warm = 0; warm < 1_000; warm++) sameJson(a, b);
		const profiler = new GCProfiler();
		profiler.start();
		const before = getHeapStatistics().used_heap_size;
		let equal = 0;
		for (let round = 0; round < 10_000; round++) if (sameJson(a, b, "granted")) equal++;
		const after = getHeapStatistics().used_heap_size;
		let freed = 0;
		for (const collection of profiler.stop().statistics) {
			freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
		}
		expect(equal).toBe(10_000);
		// Measured about 50 B per comparison (V8's for-in over an object's keys), 7.5 KiB for two canonical texts.
		expect(after - before + freed).toBeLessThan(10_000 * 500);
	});
});

describe("copyJson", () => {
	it("copies as Chord's own: other objects, an own __proto__ key kept, later changes not seen", () => {
		const value = JSON.parse('{"__proto__":1,"list":[{"n":-0}],"o":{"x":"y"}}');
		const copy = copyJson(value) as { list: { n: number }[]; o: object };
		expect([copy === value, copy.list === value.list, copy.o === value.o]).toEqual([false, false, false]);
		expect([Object.keys(copy), Object.getPrototypeOf(copy), sameJson(copy, value)]).toEqual([
			["__proto__", "list", "o"],
			Object.prototype,
			true,
		]);
		value.list[0].n = 1;
		expect([copy.list[0]!.n, sameJson(copy, value)]).toEqual([-0, false]);
	});
});
