import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getToolDescription } from "../src/prompts/index.js";
import { allTools, codingTools } from "../src/tools/index.js";

describe("todowrite integration", () => {
	describe("tool registry", () => {
		it("allTools includes todowrite", () => {
			expect("todowrite" in allTools).toBe(true);
			expect(allTools.todowrite.name).toBe("todowrite");
		});

		it("codingTools includes todowrite", () => {
			const names = codingTools.map((t) => t.name);
			expect(names).toContain("todowrite");
		});
	});

	describe("prompt system", () => {
		it("getToolDescription returns todowrite description without throwing", () => {
			const desc = getToolDescription("todowrite");
			expect(desc).toContain("task list");
			expect(desc).toContain("pending");
			expect(desc).toContain("in_progress");
		});

		it("buildSystemPrompt includes todowrite in tools list", () => {
			const prompt = buildSystemPrompt({ selectedTools: ["todowrite"] });
			expect(prompt).toContain("todowrite");
			expect(prompt).toContain("Track planning steps");
		});

		it("buildSystemPrompt works with todowrite alongside other tools", () => {
			const prompt = buildSystemPrompt({ selectedTools: ["read", "bash", "todowrite"] });
			expect(prompt).toContain("read");
			expect(prompt).toContain("bash");
			expect(prompt).toContain("todowrite");
		});
	});

	describe("tool schema", () => {
		it("todowrite has correct parameter schema", () => {
			const schema = allTools.todowrite.parameters;
			expect(schema.type).toBe("object");
			expect(schema.properties).toHaveProperty("todos");
		});
	});
});
