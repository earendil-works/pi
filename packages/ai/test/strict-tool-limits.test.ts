import { afterEach, describe, expect, it } from "vitest";
import { hasExceededStrictToolLimits, markStrictToolLimitsExceeded } from "../src/api/strict-tool-limits.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";

describe("strict tool limit sessions", () => {
	afterEach(() => cleanupSessionResources());

	it("remembers marked sessions until their cleanup", () => {
		markStrictToolLimitsExceeded("a");
		markStrictToolLimitsExceeded("b");
		markStrictToolLimitsExceeded(undefined);
		expect(hasExceededStrictToolLimits("a")).toBe(true);
		expect(hasExceededStrictToolLimits("c")).toBe(false);
		expect(hasExceededStrictToolLimits(undefined)).toBe(false);

		cleanupSessionResources("a");
		expect(hasExceededStrictToolLimits("a")).toBe(false);
		expect(hasExceededStrictToolLimits("b")).toBe(true);

		cleanupSessionResources();
		expect(hasExceededStrictToolLimits("b")).toBe(false);
	});

	it("drops the oldest session beyond 10,000", () => {
		for (let index = 0; index <= 10_000; index++) markStrictToolLimitsExceeded(`session-${index}`);
		expect(hasExceededStrictToolLimits("session-0")).toBe(false);
		expect(hasExceededStrictToolLimits("session-1")).toBe(true);
		expect(hasExceededStrictToolLimits("session-10000")).toBe(true);
	});
});
