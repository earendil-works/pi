// Verification: Auto-handoff goal prompt
import { describe, expect, it } from "vitest";
import { getAutoHandoffGoalPrompt, getHandoffFileSelectionPrompt, getHandoffPrompt } from "../src/prompts/index.js";

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

	it("should return handoff file selection prompt with XML instructions", () => {
		const goal = "Refactor the auth flow";
		const prompt = getHandoffFileSelectionPrompt(goal);

		expect(prompt).toContain(`TARGET GOAL: "${goal}"`);
		expect(prompt).toContain("Repository root:");
		expect(prompt).toContain("Current working directory:");
		expect(prompt).toContain("Path rules:");
		expect(prompt).toContain("absolute paths");
		expect(prompt).toContain("<handoff_files>");
		expect(prompt).toContain("<file>");
		expect(prompt).toContain("slice syntax");
		expect(prompt.toLowerCase()).toContain("output only xml");
		expect(prompt).not.toContain("select_handoff_files");
		expect(prompt.toLowerCase()).not.toContain("tool calling");
	});
});
