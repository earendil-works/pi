import { describe, expect, it } from "vitest";
import { track } from "../src/delta/index.ts";

describe("immutable revision ownership", () => {
	it("takes ownership of an alias-free mutable JSON root without freezing", () => {
		const input = { left: { value: 1 }, right: { value: 1 } };
		const tracker = track(input);
		expect(tracker.value).toBe(input);
		expect(tracker.value.left).not.toBe(tracker.value.right);
		expect(Object.isFrozen(tracker.value)).toBe(false);
		expect(Object.isFrozen(tracker.value.left)).toBe(false);
	});

	it("commits transaction copies in place while sharing unchanged branches", () => {
		const tracker = track({ changed: { value: 1 }, retained: { value: 2 } });
		const base = tracker.value;
		const baseSnapshot = structuredClone(base);
		const change = tracker.beginChange();
		change.state.changed.value = 3;
		const prepared = change.prepare();
		expect(prepared.value.changed).not.toBe(base.changed);
		expect(prepared.value.retained).toBe(base.retained);
		expect(Object.isFrozen(prepared.value.changed)).toBe(false);
		tracker.adopt(prepared);
		expect(base).toEqual(baseSnapshot);
		expect(tracker.value).toBe(prepared.value);
	});

	it("makes repeated placements independent", () => {
		const tracker = track({ values: [] as { value: number }[] });
		const change = tracker.beginChange();
		const shared = { value: 1 };
		change.state.values.push(shared, shared);
		const prepared = change.prepare();
		expect(prepared.value.values[0]).not.toBe(prepared.value.values[1]);
	});
});
