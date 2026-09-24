import { describe, expect, it } from "vitest";
import { applyImmutable, type Draft, type JsonValue, track } from "../src/delta/index.ts";

describe("transactional overlay drafts", () => {
	it("copies only changed branches", () => {
		const tracker = track({
			changed: { count: 1, sibling: { value: "kept" } },
			untouched: { value: 2 },
		});
		const base = tracker.value;
		const change = tracker.beginChange();
		const first = change.state.changed;
		expect(change.state.changed).toBe(first);
		change.state.changed.count = 3;
		const prepared = change.prepare();
		expect(prepared.value).not.toBe(base);
		expect(prepared.value.changed).not.toBe(base.changed);
		expect(prepared.value.changed.sibling).toBe(base.changed.sibling);
		expect(prepared.value.untouched).toBe(base.untouched);
	});

	it("supports frozen bases, deletion, and native array mutators", () => {
		const tracker = track({ optional: "remove" as string | undefined, values: [3, 1, 2] });
		const change = tracker.beginChange();
		delete change.state.optional;
		change.state.values.push(4);
		expect(change.state.values.pop()).toBe(4);
		change.state.values.unshift(0);
		expect(change.state.values.shift()).toBe(0);
		expect(change.state.values.splice(1, 1, 5, 4)).toEqual([1]);
		change.state.values.sort((left, right) => left - right);
		change.state.values.reverse();
		change.state.values.fill(9, 1, 3);
		change.state.values.copyWithin(1, 0, 2);
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ values: [5, 5, 9, 2] });
	});

	it("copies inserted draft values without aliasing their original handle", () => {
		const tracker = track({ values: [{ value: 1 }, { value: 2 }] });
		const change = tracker.beginChange();
		const held = change.state.values[0]!;
		change.state.values.unshift(held);
		held.value = 9;
		const prepared = change.prepare();
		expect(prepared.value.values).toEqual([{ value: 1 }, { value: 9 }, { value: 2 }]);
		expect(prepared.value.values[0]).not.toBe(prepared.value.values[1]);
	});

	it("keeps comparator edits when sorting object drafts", () => {
		const tracker = track({
			rows: [
				{ rank: 2, comparisons: 0 },
				{ rank: 1, comparisons: 0 },
			],
		});
		const change = tracker.beginChange();
		change.state.rows.sort((left, right) => {
			left.comparisons++;
			right.comparisons++;
			return left.rank - right.rank;
		});
		const prepared = change.prepare();
		expect(prepared.value.rows.map((row) => row.rank)).toEqual([1, 2]);
		expect(prepared.value.rows.map((row) => row.comparisons)).toEqual([1, 1]);
	});

	it("drops writes through detached child handles", () => {
		const tracker = track({ child: { value: "removed" }, items: [{ value: "removed" }, { value: "kept" }] });
		const change = tracker.beginChange();
		const child = change.state.child;
		const shifted = change.state.items.shift();
		delete (change.state as { child?: Draft<{ value: string }>; items: Draft<{ value: string }[]> }).child;
		child.value = "detached child";
		if (shifted !== undefined) shifted.value = "detached item";
		expect(change.prepare().value).toEqual({ items: [{ value: "kept" }] });
	});

	it.each(["unshift", "splice"] as const)("inserts 100,000 items with %s without argument overflow", (method) => {
		const tracker = track({ values: [-1] });
		const change = tracker.beginChange();
		const items = Array.from({ length: 100_000 }, (_, value) => value);
		if (method === "unshift") Reflect.apply(change.state.values.unshift, change.state.values, items);
		else Reflect.apply(change.state.values.splice, change.state.values, [1, 0, ...items]);
		const prepared = change.prepare();
		expect(prepared.value.values).toHaveLength(100_001);
		expect(prepared.value.values[method === "unshift" ? 0 : 1]).toBe(0);
		expect(prepared.value.values[method === "unshift" ? 99_999 : 100_000]).toBe(99_999);
		expect(applyImmutable(prepared.base, prepared.ops)).toEqual(prepared.value);
	});

	it("rejects non-strict JSON placements without mutating the draft or base", () => {
		const tracker = track({ number: 0, payload: null as JsonValue, values: [1, 2] as JsonValue[] });
		const change = tracker.beginChange();
		expect(() => {
			change.state.values[0] = undefined as unknown as JsonValue;
		}).toThrow(/strict JSON/);
		expect(() => change.state.values.push({ nested: undefined } as unknown as JsonValue)).toThrow(/strict JSON/);
		expect(() => {
			change.state.number = Number.NaN;
		}).toThrow(/strict JSON/);
		expect(() => {
			change.state.payload = new Date() as unknown as JsonValue;
		}).toThrow(/plain objects/);
		expect(change.state).toEqual(tracker.value);
		change.abort();
		expect(tracker.value).toEqual({ number: 0, payload: null, values: [1, 2] });
	});

	it("rejects array holes without mutating the committed base", () => {
		const tracker = track({ values: [1, 2] });
		const change = tracker.beginChange();
		expect(() => delete change.state.values[0]).toThrow(/dense|holes/);
		change.abort();
		expect(tracker.value.values).toEqual([1, 2]);
	});
});
