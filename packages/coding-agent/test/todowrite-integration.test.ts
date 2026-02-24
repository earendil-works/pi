import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getToolDescription } from "../src/prompts/index.js";
import { allTools, codingTools } from "../src/tools/index.js";

describe("todo_write integration", () => {
	describe("tool registry", () => {
		it("allTools includes todo_write and excludes legacy tools", () => {
			expect("todo_write" in allTools).toBe(true);
			expect("todo" in allTools).toBe(false);
			expect("update_plan" in allTools).toBe(false);
			expect("view_image" in allTools).toBe(false);
			expect(allTools.todo_write.name).toBe("todo_write");
		});

		it("codingTools includes todo_write", () => {
			const names = codingTools.map((t) => t.name);
			expect(names).toContain("todo_write");
		});
	});

	describe("prompt system", () => {
		it("getToolDescription returns todo_write description without throwing", () => {
			const desc = getToolDescription("todo_write");
			expect(desc).toContain("structured");
			expect(desc).toContain("Replaces the full list");
		});

		it("buildSystemPrompt includes todo_write in tools list", async () => {
			const prompt = await buildSystemPrompt({ tools: [{ name: "todo_write" }] });
			expect(prompt).toContain("todo_write");
			expect(prompt).toContain("structured");
		});

		it("buildSystemPrompt works with todo_write alongside other tools", async () => {
			const prompt = await buildSystemPrompt({
				tools: [{ name: "read" }, { name: "bash" }, { name: "todo_write" }],
			});
			expect(prompt).toContain("read");
			expect(prompt).toContain("bash");
			expect(prompt).toContain("todo_write");
		});
	});

	describe("tool schema", () => {
		it("todo_write has correct parameter schema", () => {
			const schema = allTools.todo_write.parameters;
			expect(schema.type).toBe("object");
			expect(schema.properties).toHaveProperty("todos");
		});
	});
});
