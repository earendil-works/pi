import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getToolDescription } from "../src/prompts/index.js";
import { allTools, codingTools } from "../src/tools/index.js";

describe("todowrite integration", () => {
	describe("tool registry", () => {
		it("allTools includes TodoWrite", () => {
			expect("TodoWrite" in allTools).toBe(true);
			expect(allTools.TodoWrite.name).toBe("TodoWrite");
		});

		it("codingTools includes TodoWrite", () => {
			const names = codingTools.map((t) => t.name);
			expect(names).toContain("TodoWrite");
		});
	});

	describe("prompt system", () => {
		it("getToolDescription returns TodoWrite description without throwing", () => {
			const desc = getToolDescription("TodoWrite");
			expect(desc).toContain("task list");
			expect(desc).toContain("pending");
			expect(desc).toContain("in_progress");
		});

		it("buildSystemPrompt includes TodoWrite in tools list", async () => {
			const prompt = await buildSystemPrompt({ selectedTools: ["TodoWrite"] });
			expect(prompt).toContain("TodoWrite");
			expect(prompt).toContain("task list");
		});

		it("buildSystemPrompt works with TodoWrite alongside other tools", async () => {
			const prompt = await buildSystemPrompt({ selectedTools: ["Read", "Bash", "TodoWrite"] });
			expect(prompt).toContain("Read");
			expect(prompt).toContain("Bash");
			expect(prompt).toContain("TodoWrite");
		});
	});

	describe("tool schema", () => {
		it("TodoWrite has correct parameter schema", () => {
			const schema = allTools.TodoWrite.parameters;
			expect(schema.type).toBe("object");
			expect(schema.properties).toHaveProperty("todos");
		});
	});
});
