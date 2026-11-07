import { describe, expect, it } from "vitest";
import { isWithinEnvelope, MAX_AGENTS, resolveAgentCount } from "../src/index.ts";

describe("supervisor ui envelope", () => {
	it("range is an envelope, planner picks inside based on capacity", () => {
		expect(resolveAgentCount("3-4", undefined, 10)).toBe(4);
		expect(resolveAgentCount("3-4", undefined, 1)).toBe(3);
		expect(resolveAgentCount("5-6", undefined, 5)).toBe(5);
		expect(resolveAgentCount("exact", 3, 10)).toBe(3);
		expect(isWithinEnvelope(3, "3-4")).toBe(true);
		expect(isWithinEnvelope(9, "3-4")).toBe(false);
		expect(() => resolveAgentCount("exact", 99, 10)).toThrow(`max ${MAX_AGENTS}`);
	});
});
