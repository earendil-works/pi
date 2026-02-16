import type { AgentTool } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { allTools } from "./index.js";
import { resolveToolSelection } from "./tool-selection.js";

function asToolMap(tools: unknown): Record<string, AgentTool> {
	return tools as Record<string, AgentTool>;
}

describe("GPT tools", () => {
	it("registers Codex-style tool names in allTools", () => {
		const toolMap = asToolMap(allTools);
		const names = Object.keys(toolMap);

		expect(names).toContain("exec_command");
		expect(names).toContain("apply_patch");
		expect(names).toContain("view_image");
		expect(names).toContain("update_plan");

		expect(toolMap.exec_command?.name).toBe("exec_command");
		expect(toolMap.apply_patch?.name).toBe("apply_patch");
		expect(toolMap.view_image?.name).toBe("view_image");
		expect(toolMap.update_plan?.name).toBe("update_plan");

		// OpenAI function tools require parameters schema to be an object.
		expect(toolMap.apply_patch?.parameters?.type).toBe("object");
	});

	it("defaults GPT-* models to the restricted tool set", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toEqual(["exec_command", "read_image", "handoff", "list_threads", "read_thread"]);
		expect(selection.tools.map((t) => t.name)).toEqual(selection.toolNames);
	});

	it("keeps the GPT-ish default for OpenAI non-GPT-* models", () => {
		const model = getModel("openai", "codex-mini-latest");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toContain("bash");
		expect(selection.toolNames).toContain("apply_patch");
		expect(selection.toolNames).toContain("write");
		expect(selection.toolNames).toContain("todo");
	});
});
