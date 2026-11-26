import { describe, expect, it } from "vitest";
import {
	applyImmutable,
	assertValidOp,
	assertValidWireOp,
	decoder,
	diffRevisions,
	encoder,
	type Op,
} from "../src/delta/index.ts";
import type { JsonValue } from "../src/json.ts";

const expectDiff = (before: JsonValue, after: JsonValue, expected: unknown): void => {
	const operations = diffRevisions(before, after);
	expect(operations).toEqual(expected);
	expect(applyImmutable(before, operations)).toEqual(after);
};

describe("immutable revision diff", () => {
	it("emits sets and deletes", () => {
		expectDiff({ keep: 1, change: 1, remove: true }, { keep: 1, change: 2, add: 3 }, [
			["s", ["change"], 2],
			["s", ["add"], 3],
			["d", ["remove"]],
		]);
	});

	it("emits string append and front truncation", () => {
		expectDiff({ text: "hello" }, { text: "hello world" }, [["a", ["text"], " world"]]);
		expectDiff({ text: "hello world" }, { text: "world" }, [["t", ["text"], 6]]);
		expectDiff({ text: "abcdefgh" }, { text: "defghxyz" }, [
			["t", ["text"], 3],
			["a", ["text"], "xyz"],
		]);
	});

	it("represents array insertion, removal, and shift with splices", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		expectDiff({ values: [a, b] }, { values: [a, c, b] }, [["p", ["values"], 1, 0, [c]]]);
		expectDiff({ values: [a, b, c] }, { values: [b, c] }, [["p", ["values"], 0, 1, []]]);
	});

	it("collapses a same-length queue update to two splices", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		const d = { id: "d" };
		expectDiff({ values: [a, b, c] }, { values: [b, c, d] }, [
			["p", ["values"], 0, 1, []],
			["p", ["values"], 2, 0, [d]],
		]);
	});

	it("emits a permutation for a pure reorder", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		expectDiff({ values: [a, b, c] }, { values: [c, a, b] }, [["m", ["values"], [2, 0, 1]]]);
	});

	it("normalizes reordered distinct deeply-equal objects to a no-op", () => {
		const first = { nested: { value: 1 } };
		const second = { nested: { value: 1 } };
		expect(first).not.toBe(second);
		expect(diffRevisions({ values: [first, second] }, { values: [second, first] })).toEqual([]);
	});

	it("validates and encodes permutations", () => {
		const operations: Op[] = [
			["m", ["values"], [2, 0, 1]],
			["m", ["values"], [1, 2, 0]],
		];
		for (const operation of operations) assertValidOp(operation);
		const wire = encoder().encode(operations);
		expect(wire).toEqual([
			["m", ["values"], [2, 0, 1]],
			["m", [1, 2, 0]],
		]);
		for (const operation of wire) assertValidWireOp(operation);
		expect(decoder().decode(wire)).toEqual(operations);
		expect(() => assertValidOp(["m", ["values"], [0, 0]])).toThrow(/bijection/);
	});

	it("emits nothing for deeply equal reconstructed values", () => {
		expect(diffRevisions({ value: { nested: [1, 2] } }, { value: { nested: [1, 2] } })).toEqual([]);
		expect(diffRevisions({ values: [{ id: 1 }, { id: 2 }] }, { values: [{ id: 1 }, { id: 2 }] })).toEqual([]);
		expect(diffRevisions({ values: [true, true, true] }, { values: [true, true, true] })).toEqual([]);
	});

	it("keeps a leaf edit inside a reconstructed array narrow", () => {
		expectDiff(
			{
				values: [
					{ id: 1, label: "one" },
					{ id: 2, label: "two" },
				],
			},
			{
				values: [
					{ id: 1, label: "one" },
					{ id: 2, label: "changed" },
				],
			},
			[["s", ["values", 1, "label"], "changed"]],
		);
	});

	it("emits payload-free splices for scattered removals", () => {
		const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
		expectDiff({ values: [a, b, c, d, e] }, { values: [a, c, e] }, [
			["p", ["values"], 1, 1, []],
			["p", ["values"], 2, 1, []],
		]);
	});

	it.each([
		["front", [1, 2, 3, 4], [2, 3, 4], [["p", ["values"], 0, 1, []]]],
		["tail", [1, 2, 3, 4], [1, 2, 3], [["p", ["values"], 3, 1, []]]],
		["middle", [1, 2, 3, 4], [1, 3, 4], [["p", ["values"], 1, 1, []]]],
		["all", [1, 2, 3, 4], [], [["p", ["values"], 0, 4, []]]],
		["none", [1, 2, 3, 4], [1, 2, 3, 4], []],
	] as const)("encodes %s removal canonically", (_name, before, after, expected) => {
		expectDiff({ values: [...before] }, { values: [...after] }, expected);
	});

	it("does not field-diff unrelated shifted objects with common fields", () => {
		const before = [1, 2, 3].map((value) => ({ type: "row", value }));
		const after = [2, 3, 4].map((value) => ({ type: "row", value }));
		expectDiff({ values: before }, { values: after }, [
			["p", ["values"], 0, 1, []],
			["p", ["values"], 2, 0, [{ type: "row", value: 4 }]],
		]);
	});

	it("does not treat coincidental id or key fields as structural identity", () => {
		const left = { value: "left" };
		const right = { value: "right" };
		const before = [left, { id: 1, key: "a", value: "first" }, { id: 2, key: "b", value: "second" }, right];
		const replacements = [
			{ id: 2, key: "b", value: "edited-second" },
			{ id: 1, key: "a", value: "edited-first" },
		];
		const after = [left, ...replacements, right];
		expectDiff({ values: before }, { values: after }, [["p", ["values"], 1, 2, replacements]]);
	});

	it("combines removals, append, and a shared-subtree survivor edit", () => {
		const a = { id: "a", stable: {}, detail: { text: "a" } };
		const b = { id: "b", stable: {}, detail: { text: "b" } };
		const c = { id: "c", stable: {}, detail: { text: "c" } };
		const d = { id: "d", stable: {}, detail: { text: "d" } };
		const changedC = { id: "c", stable: c.stable, detail: { text: "changed" } };
		const appended = { id: "e", stable: {}, detail: { text: "e" } };
		expectDiff({ values: [a, b, c, d] }, { values: [a, changedC, d, appended] }, [
			["p", ["values"], 1, 1, []],
			["a", ["values", 1, "detail", "text"], "hanged"],
			["p", ["values"], 3, 0, [appended]],
		]);
	});

	it.each([256 * 1024, 1024 * 1024])("does not retain a %i-byte removed-neighbor payload", (size) => {
		const payload = "x".repeat(size);
		const retained = [
			{ id: "a", payload },
			{ id: "b", payload },
			{ id: "c", payload },
			{ id: "d", payload },
			{ id: "e", payload },
		];
		const before = Object.freeze({ values: Object.freeze(retained.slice()) });
		const after = Object.freeze({ values: Object.freeze([retained[0]!, retained[2]!, retained[4]!]) });
		const operations = diffRevisions(before as unknown as JsonValue, after as unknown as JsonValue);
		expect(operations).toEqual([
			["p", ["values"], 1, 1, []],
			["p", ["values"], 2, 1, []],
		]);
		expect(JSON.stringify(operations).length).toBeLessThan(100);
		expect(applyImmutable(before, operations)).toEqual(after);
		expect(before.values).toEqual(retained);
	});

	it.each([1_001, 10_000])("keeps push, pop, and middle removal narrow at %,i items", (size) => {
		const values = Array.from({ length: size }, (_, value) => ({ value }));
		const appended = { value: size };
		expectDiff({ values }, { values: [...values, appended] }, [["p", ["values"], size, 0, [appended]]]);
		expectDiff({ values }, { values: values.slice(0, -1) }, [["p", ["values"], size - 1, 1, []]]);
		const middle = Math.floor(size / 2);
		expectDiff({ values }, { values: [...values.slice(0, middle), ...values.slice(middle + 1)] }, [
			["p", ["values"], middle, 1, []],
		]);
	});

	it("keeps forty-thousand-row sparse edits narrow", () => {
		const values = Array.from({ length: 40_000 }, (_, value) => ({ value, stable: { value } }));
		const after = values.slice();
		const changed: number[] = [];
		for (let index = 100; index < after.length; index += 400) {
			after[index] = { value: -index, stable: values[index]!.stable };
			changed.push(index);
		}
		const operations = diffRevisions({ values }, { values: after });
		expect(operations).toEqual(changed.map((index) => ["s", ["values", index, "value"], -index]));
		expect(JSON.stringify(operations).length).toBeLessThan(7_500);
		expect(applyImmutable({ values }, operations)).toEqual({ values: after });
	});

	it("keeps a reconstructed large-array leaf edit narrow", () => {
		const before = Array.from({ length: 1_000 }, (_, value) => ({ value, label: `row-${value}` }));
		const after = structuredClone(before);
		after[700]!.label = "changed";
		const operations = diffRevisions({ values: before }, { values: after });
		expect(operations).toEqual([["s", ["values", 700, "label"], "changed"]]);
		expect(JSON.stringify(operations).length).toBeLessThan(100);
		expect(applyImmutable({ values: before }, operations)).toEqual({ values: after });
	});

	it("splices an ambiguous equal-count moved-and-edited gap", () => {
		const left = { value: "left" };
		const right = { value: "right" };
		const before = [left, { id: 1, value: "a" }, { id: 2, value: "b" }, right];
		const replacements = [
			{ id: 2, value: "edited" },
			{ id: 1, value: "also-edited" },
		];
		const after = [left, ...replacements, right];
		expectDiff({ values: before }, { values: after }, [["p", ["values"], 1, 2, replacements]]);
	});

	it("keeps a large rotation payload-free", () => {
		const values = Array.from({ length: 10_000 }, (_, value) => ({ value }));
		const rotated = [...values.slice(1_000), ...values.slice(0, 1_000)];
		const operations = diffRevisions({ values }, { values: rotated });
		expect(operations).toHaveLength(1);
		expect(operations[0]?.[0]).toBe("m");
		expect(JSON.stringify(operations).length).toBeLessThan(60_000);
		expect(applyImmutable({ values }, operations)).toEqual({ values: rotated });
	});

	it("finds a window moved by k items by identity, with the region diff's ops (ERNDL-1176, step 4)", () => {
		const rows = Array.from({ length: 50 }, (_, id) => ({ id }));
		const came = [{ id: 100 }, { id: 101 }];
		// Newest first: two rows on top, the last two gone.
		expectDiff({ rows }, { rows: [...came, ...rows.slice(0, 48)] }, [
			["p", ["rows"], 0, 0, came],
			["p", ["rows"], 50, 2, []],
		]);
		// Oldest first: the first two gone, two rows behind.
		expectDiff({ rows }, { rows: [...rows.slice(2), ...came] }, [
			["p", ["rows"], 0, 2, []],
			["p", ["rows"], 48, 0, came],
		]);
		// The rows that left come back (a rotation): a permutation, as before.
		expect(diffRevisions({ rows }, { rows: [...rows.slice(48), ...rows.slice(0, 48)] })[0]?.[0]).toBe("m");
	});

	it("reads a shifted window's items about twice, not eight times (ERNDL-1176, step 4: issue test 9)", () => {
		// Before the shift's own path: a permutation's map, the positional pass, the identity anchors and their matches
		// read 8n + 10 items of a window of n; now finding the shift and confirming it read 2n + 8.
		for (const length of [50, 500]) {
			const rows = Array.from({ length }, (_, id) => ({ id }));
			let reads = 0;
			const counted = (items: JsonValue[]): JsonValue[] =>
				new Proxy(items, {
					get: (target, key, receiver) => {
						if (typeof key === "string" && /^\d+$/.test(key)) reads++;
						return Reflect.get(target, key, receiver);
					},
				});
			const operations = diffRevisions(
				{ rows: counted(rows) },
				{ rows: counted([{ id: -1 }, ...rows.slice(0, -1)]) },
			);
			expect(operations).toHaveLength(2);
			expect(reads).toBeLessThanOrEqual(2 * length + 8);
		}
	});

	it("diffs every shift, rotation and near-shift into ops that give the new value (ERNDL-1176, step 4)", () => {
		let seed = 7;
		const random = (below: number): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed % below;
		};
		for (let round = 0; round < 500; round++) {
			const length = 2 + random(30);
			const rows = Array.from({ length }, (_, id) => ({ id }));
			const k = 1 + random(length - 1);
			const fresh = Array.from({ length: k }, (_, id) => ({ id: 1_000 + id }));
			// New rows, rows that left coming back, or one of them a copy (equal, not the same object).
			const came = [fresh, rows.slice(length - k), [...fresh.slice(1), { ...rows[0]! }]][random(3)]!;
			const after = random(2) === 0 ? [...came, ...rows.slice(0, length - k)] : [...rows.slice(k), ...came];
			if (random(4) === 0) after[random(length)] = { id: -1 };
			const operations = diffRevisions({ rows }, { rows: after });
			expect(applyImmutable({ rows }, operations)).toEqual({ rows: after });
		}
	});

	it("encodes five hundred unshifts without snapshotting retained rows", () => {
		const retained = Array.from({ length: 10_000 }, (_, value) => ({ value, payload: "x".repeat(100) }));
		const inserted = Array.from({ length: 500 }, (_, value) => ({ value: -value - 1 }));
		const operations = diffRevisions({ values: retained }, { values: [...inserted, ...retained] });
		expect(operations).toEqual([["p", ["values"], 0, 0, inserted]]);
		expect(JSON.stringify(operations).length).toBeLessThan(20_000);
		expect(applyImmutable({ values: retained }, operations)).toEqual({ values: [...inserted, ...retained] });
	});

	it("bounds wide-object operation emission with a root replacement", () => {
		const before: Record<string, JsonValue> = {};
		const after: Record<string, JsonValue> = {};
		for (let index = 0; index < 20_000; index++) {
			before[`field${index}`] = 0;
			after[`field${index}`] = 1;
		}
		expect(diffRevisions(before, after)).toEqual([["r", after]]);
	});

	it("bounds a wide normalized array fallback with a root replacement", () => {
		const before = { values: Array.from({ length: 40_000 }, () => 0) };
		const after = { values: Array.from({ length: 40_000 }, () => 1) };
		const operations = diffRevisions(before, after);
		expect(operations).toEqual([["r", after]]);
		expect(applyImmutable(before, operations)).toEqual(after);
	});
});
