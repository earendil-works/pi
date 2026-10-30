import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { combineUsage } from "../src/core/usage-totals.ts";

function usage(total: number, totalFromProvider?: boolean): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total,
			...(totalFromProvider === undefined ? {} : { totalFromProvider }),
		},
	};
}

describe("combineUsage", () => {
	it("marks the combined total as provider-reported only when both totals are", () => {
		expect(combineUsage(usage(1, true), usage(2, true)).cost).toMatchObject({ total: 3, totalFromProvider: true });
		expect(combineUsage(usage(1, true), usage(2)).cost.totalFromProvider).toBe(false);
		expect(combineUsage(usage(1), usage(2, true)).cost.totalFromProvider).toBe(false);
		expect(combineUsage(usage(1), usage(2)).cost.totalFromProvider).toBe(false);
	});
});
