import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getToolDescription } from "../src/prompts/index.js";
import { allTools, codingTools } from "../src/tools/index.js";

// Historically this file verified TodoWrite wiring.
// It now verifies the replacement Todo tool is correctly wired.
describe("todo integration", () => {
	describe("tool registry", () => {
		it("allTools includes Todo", () => {
			expect("todo" in allTools).toBe(true);
			expect(allTools.todo.name).toBe("todo");
		});

		it("codingTools includes Todo", () => {
			const names = codingTools.map((t) => t.name);
			expect(names).toContain("todo");
		});
	});

	describe("prompt system", () => {
		it("getToolDescription returns Todo description without throwing", () => {
			const desc = getToolDescription("todo");
			expect(desc).toContain("file-backed");
			expect(desc).toContain("claim_next");
		});

		it("buildSystemPrompt includes Todo in tools list", async () => {
			const prompt = await buildSystemPrompt({ selectedTools: ["todo"] });
			expect(prompt).toContain("todo");
			expect(prompt).toContain("file-backed");
		});

		it("buildSystemPrompt works with Todo alongside other tools", async () => {
			const prompt = await buildSystemPrompt({ selectedTools: ["read", "bash", "todo"] });
			expect(prompt).toContain("read");
			expect(prompt).toContain("bash");
			expect(prompt).toContain("todo");
		});
	});

	describe("tool schema", () => {
		it("Todo has correct parameter schema", () => {
			const schema = allTools.todo.parameters;
			expect(schema.type).toBe("object");
			expect(schema.properties).toHaveProperty("action");
		});
	});
});
