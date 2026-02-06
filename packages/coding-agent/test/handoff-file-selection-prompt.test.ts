import { describe, expect, it } from "vitest";
import { buildHandoffFileSelectionPrompt, getHandoffFileSelectionPrompt } from "../src/prompts/index.js";

describe("buildHandoffFileSelectionPrompt", () => {
	it("includes a file tree block when provided", () => {
		const tree = "packages/\n\tfoo/\n\t\tbar.ts\nREADME.md";
		const prompt = buildHandoffFileSelectionPrompt({ goal: "Fix handoff paths", fileTree: tree });

		// The model should be able to see the tree plainly.
		expect(prompt).toContain("Project file tree");
		expect(prompt).toContain("<file_tree>");
		expect(prompt).toContain("README.md");
		expect(prompt).toContain("</file_tree>");
	});

	it("does not include a file tree block when omitted", () => {
		const prompt = buildHandoffFileSelectionPrompt({ goal: "Fix handoff paths" });
		expect(prompt).not.toContain("<file_tree>");
	});

	it("preserves the original selection instructions", () => {
		const base = getHandoffFileSelectionPrompt("Fix handoff paths");
		const prompt = buildHandoffFileSelectionPrompt({
			goal: "Fix handoff paths",
			fileTree: "README.md",
		});
		expect(prompt).toContain(base.trim());
		expect(prompt).toContain("Output ONLY XML");
	});
});
