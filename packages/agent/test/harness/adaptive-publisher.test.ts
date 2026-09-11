import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptivePublisher } from "../../src/harness/utils/adaptive-publisher.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("AdaptivePublisher", () => {
	it("bounds event count and spaces large publications by encoded size", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let value = "a";
		const updates: string[] = [];
		const publisher = new AdaptivePublisher({
			snapshot: () => value,
			update: (_previous, current) => current,
			measure: (update) => update.length,
			publish: (update) => updates.push(update),
			onError: (error) => {
				throw error;
			},
			minIntervalMs: 100,
			targetBytesPerSecond: 100,
		});

		publisher.markDirty();
		value = "x".repeat(100);
		publisher.markDirty();
		vi.advanceTimersByTime(100);
		expect(updates).toEqual(["a", "x".repeat(100)]);

		value = "held";
		publisher.markDirty();
		vi.advanceTimersByTime(999);
		expect(updates).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(updates).toEqual(["a", "x".repeat(100), "held"]);
	});

	it("commits its baseline before a consumer throws", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let value = "a";
		const updates: Array<{ previous: string | undefined; current: string }> = [];
		let throwAfterApply = false;
		const publisher = new AdaptivePublisher({
			snapshot: () => value,
			update: (previous, current) => ({ previous, current }),
			measure: () => 1,
			publish: (update) => {
				updates.push(update);
				if (throwAfterApply) throw new Error("consumer failed after apply");
			},
			onError: () => {},
			minIntervalMs: 100,
			targetBytesPerSecond: 100,
		});

		publisher.markDirty();
		vi.advanceTimersByTime(100);
		value = "ab";
		throwAfterApply = true;
		expect(() => publisher.markDirty()).toThrow("consumer failed after apply");
		publisher.flush(true);
		expect(updates).toEqual([
			{ previous: undefined, current: "a" },
			{ previous: "a", current: "ab" },
		]);

		throwAfterApply = false;
		vi.advanceTimersByTime(100);
		value = "abc";
		publisher.markDirty();
		expect(updates.at(-1)).toEqual({ previous: "ab", current: "abc" });
	});
});
