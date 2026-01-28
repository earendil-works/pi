import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_NAMES, resolveToolSelection } from "./tool-selection.js";

describe("resolveToolSelection", () => {
	it("replaces Edit with ApplyPatch for GPT models", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const selection = resolveToolSelection(DEFAULT_TOOL_NAMES, model);

		expect(selection.toolNames).toContain("ApplyPatch");
		expect(selection.toolNames).not.toContain("Edit");
		expect(selection.toolNames).not.toContain("Write");
		expect(selection.replacedWithApplyPatch).toBe(true);
	});

	it("keeps Edit and Write for non-GPT models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const selection = resolveToolSelection(DEFAULT_TOOL_NAMES, model);

		expect(selection.toolNames).toContain("Edit");
		expect(selection.toolNames).toContain("Write");
		expect(selection.replacedWithApplyPatch).toBe(false);
	});
});
