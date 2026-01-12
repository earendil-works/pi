// Verification: Auto-handoff goal prompt
import { describe, expect, it } from "vitest";
import { getAutoHandoffGoalPrompt, getHandoffPrompt } from "../src/prompts/index.js";

describe("Auto-Handoff Prompts", () => {
	it("should return goal prompt with correct constraints", () => {
		const prompt = getAutoHandoffGoalPrompt();

		// Should contain key constraints
		expect(prompt).toContain("ONE short, imperative goal");
		expect(prompt).toContain("max 12 words");
		expect(prompt).toContain("No quotes");
		expect(prompt).toContain("No markdown");
		expect(prompt).toContain("Start with a verb");
		expect(prompt).toContain("Continue the current task");
	});

	it("should return handoff prompt with goal embedded", () => {
		const goal = "Implement the login feature";
		const prompt = getHandoffPrompt(goal);

		expect(prompt).toContain(`TARGET GOAL: "${goal}"`);
		expect(prompt).toContain("## Context Summary");
		expect(prompt).toContain("## Current Status");
		expect(prompt).toContain("## Relevant Files");
		expect(prompt).toContain("## Next Steps");
	});
});
