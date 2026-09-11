import { describe, expect, it } from "vitest";
import { retryNotBefore } from "../../../src/harness/runtime/drive/retry.ts";

describe("runtime retry delay", () => {
	it("uses capped delay when computing retry readiness", () => {
		// Regression for #8826.
		expect(retryNotBefore({ baseDelayMs: 2000, maxAgentDelayMs: 30000 }, 5, 100)).toBe(30100);
	});
});
