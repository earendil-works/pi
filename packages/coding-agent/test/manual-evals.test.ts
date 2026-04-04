import { describe, expect, it } from "vitest";
import { getManualEvalScenarios } from "./manual-evals/scenarios.js";

describe("manual eval scenarios", () => {
	it("exposes curated scenarios for discovery, plan-mode, and max-edit", () => {
		expect(getManualEvalScenarios({ suite: "discovery" })).toHaveLength(1);
		expect(getManualEvalScenarios({ suite: "plan-mode" })).toHaveLength(1);
		expect(getManualEvalScenarios({ suite: "max-edit" })).toHaveLength(1);
	});

	it("filters scenarios by exact name", () => {
		const scenarios = getManualEvalScenarios({ name: "rename-constant-via-max-edit" });

		expect(scenarios).toHaveLength(1);
		expect(scenarios[0]?.suite).toBe("max-edit");
	});
});
