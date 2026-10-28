import { describe, expect, it } from "vitest";
import { apply, track } from "../src/delta/index.ts";

describe("tracker ownership", () => {
	it("takes immutable ownership of the imported revision in O(1)", () => {
		const input = {
			point: { x: 3, y: 7, pressure: 0.1 },
			rows: [{ values: [0, false, null, "text", { n: 1 }] }],
		};
		const tracker = track(input);
		expect(tracker.value).toBe(input);
		expect(tracker.value.point).toBe(input.point);
		expect(tracker.value.rows[0]!.values[4]).toBe(input.rows[0]!.values[4]);
		expect(Object.isFrozen(tracker.value.rows[0]!.values)).toBe(false);
	});

	it("preserves null prototypes in an alias-free owned root", () => {
		type Dictionary = { enabled: boolean; child: { n: number } };
		const dictionary = Object.assign(Object.create(null) as Dictionary, { enabled: true, child: { n: 1 } });
		const tracker = track({ dictionary, left: { nested: [{ n: 1 }] }, right: { nested: [{ n: 1 }] } });
		expect(Object.getPrototypeOf(tracker.value.dictionary)).toBeNull();
		expect(tracker.value.dictionary).toBe(dictionary);
		expect(tracker.value.left).not.toBe(tracker.value.right);
		expect(tracker.value.left.nested[0]).not.toBe(tracker.value.right.nested[0]);
	});

	it("does not traverse a trusted root while taking ownership", () => {
		let reads = 0;
		const input = Object.defineProperty({}, "untrustedAccessor", {
			enumerable: true,
			get() {
				reads += 1;
				throw new Error("root was traversed");
			},
		});
		const tracker = track(input);
		expect(tracker.value).toBe(input);
		expect(reads).toBe(0);
	});

	it("copies assigned and inserted values immediately", () => {
		const tracker = track({ rows: [] as { nested: { value: number } }[] });
		const assigned = { nested: { value: 1 } };
		const change = tracker.beginChange();
		change.state.rows.push(assigned);
		assigned.nested.value = 9;
		expect(change.state.rows[0]!.nested.value).toBe(1);
		const prepared = change.prepare();
		expect(prepared.value.rows[0]!.nested.value).toBe(1);
		const replica = apply(structuredClone(prepared.base), prepared.ops);
		expect(replica).toEqual(prepared.value);
	});
});
