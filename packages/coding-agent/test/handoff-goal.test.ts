import type { Message } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

import { GENERIC_HANDOFF_GOAL, normalizeAutoHandoffGoal, normalizeHandoffGoalFromFiles } from "../src/handoff-goal.js";
import { handoffTool } from "../src/tools/handoff.js";

function makeUserMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("handoff goal normalization", () => {
	describe("normalizeAutoHandoffGoal", () => {
		it("falls back to last user goal when model returns generic", () => {
			const messages: Message[] = [makeUserMessage("Fix the failing unit tests")];

			const goal = normalizeAutoHandoffGoal({ modelGoal: GENERIC_HANDOFF_GOAL, messages });
			expect(goal).toBe("Fix the failing unit tests");
		});

		it("creates an imperative fallback when last user message is not a goal", () => {
			const messages: Message[] = [makeUserMessage("The handoff goal is generic; make it specific")];

			const goal = normalizeAutoHandoffGoal({ modelGoal: "", messages });
			expect(goal).not.toBe("");
			expect(goal).not.toBe(GENERIC_HANDOFF_GOAL);
			expect(goal.toLowerCase()).toContain("handoff");
			expect(goal).toMatch(/^Address\b/);
		});
	});

	describe("normalizeHandoffGoalFromFiles", () => {
		it("derives a non-generic goal from file names when goal is generic", () => {
			const goal = normalizeHandoffGoalFromFiles({
				goal: GENERIC_HANDOFF_GOAL,
				files: ["packages/coding-agent/src/tools/handoff.ts:1-3"],
			});

			expect(goal).not.toBe(GENERIC_HANDOFF_GOAL);
			expect(goal.toLowerCase()).toContain("handoff.ts");
		});

		it("preserves a specific goal", () => {
			const goal = normalizeHandoffGoalFromFiles({
				goal: "Implement the OAuth logout flow",
				files: ["packages/coding-agent/src/tools/handoff.ts:1-3"],
			});

			expect(goal).toBe("Implement the OAuth logout flow");
		});
	});

	it("handoffTool.execute normalizes generic goals", async () => {
		const result = await handoffTool.execute("id", {
			goal: GENERIC_HANDOFF_GOAL,
			files: ["README.md:1-3"],
		});

		expect(result.details.goal).toBe("Continue work in README.md");
		expect(result.details.formattedMessage).toContain("## Goal\nContinue work in README.md");
	});
});
