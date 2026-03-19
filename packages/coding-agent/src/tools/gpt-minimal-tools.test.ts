import type { AgentTool } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { allTools } from "./index.js";
import { resolveToolSelection } from "./tool-selection.js";

function asToolMap(tools: unknown): Record<string, AgentTool> {
	return tools as Record<string, AgentTool>;
}

describe("GPT tools", () => {
	it("registers optional Codex-style tool names in allTools", () => {
		const toolMap = asToolMap(allTools);
		const names = Object.keys(toolMap);

		expect(names).toContain("exec_command");
		expect(names).toContain("apply_patch");
		expect(names).toContain("todo_write");
		expect(names).not.toContain("todo");
		expect(names).not.toContain("update_plan");
		expect(names).not.toContain("view_image");

		expect(toolMap.exec_command?.name).toBe("exec_command");
		expect(toolMap.apply_patch?.name).toBe("apply_patch");
		expect(toolMap.todo_write?.name).toBe("todo_write");

		// OpenAI function tools require parameters schema to be an object.
		expect(toolMap.apply_patch?.parameters?.type).toBe("object");
	});

	it("defaults GPT-* models to the GPT tool set", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toEqual([
			"bash",
			"apply_patch",
			"list_threads",
			"read_thread",
			"read_image",
			"spawn_agent",
			"wait_agent",
			"compact",
		]);
		expect(selection.tools.map((t) => t.name)).toEqual(selection.toolNames);
	});

	it("uses the regular default for OpenAI non-GPT-* models", () => {
		const model = getModel("openai", "codex-mini-latest");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toContain("bash");
		expect(selection.toolNames).toContain("edit");
		expect(selection.toolNames).toContain("write");
		expect(selection.toolNames).not.toContain("todo_write");
		expect(selection.toolNames).not.toContain("exec_command");
	});
});
