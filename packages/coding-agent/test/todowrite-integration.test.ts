import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getToolDescription } from "../src/prompts/index.js";
import { allTools, codingTools } from "../src/tools/index.js";

// Historically this file verified TodoWrite wiring.
// It now verifies the replacement Todo tool is correctly wired.
describe("todo integration", () => {
	describe("tool registry", () => {
		it("allTools includes Todo", () => {
			expect("Todo" in allTools).toBe(true);
			expect(allTools.Todo.name).toBe("Todo");
		});

		it("codingTools includes Todo", () => {
			const names = codingTools.map((t) => t.name);
			expect(names).toContain("Todo");
		});
	});

	describe("prompt system", () => {
		it("getToolDescription returns Todo description without throwing", () => {
			const desc = getToolDescription("Todo");
			expect(desc).toContain("file-backed");
			expect(desc).toContain("claim_next");
		});

		it("buildSystemPrompt includes Todo in tools list", async () => {
			const prompt = await buildSystemPrompt({ selectedTools: ["Todo"] });
			expect(prompt).toContain("Todo");
			expect(prompt).toContain("file-backed");
		});

		it("buildSystemPrompt works with Todo alongside other tools", async () => {
			const prompt = await buildSystemPrompt({ selectedTools: ["Read", "Bash", "Todo"] });
			expect(prompt).toContain("Read");
			expect(prompt).toContain("Bash");
			expect(prompt).toContain("Todo");
		});
	});

	describe("tool schema", () => {
		it("Todo has correct parameter schema", () => {
			const schema = allTools.Todo.parameters;
			expect(schema.type).toBe("object");
			expect(schema.properties).toHaveProperty("action");
		});
	});
});
