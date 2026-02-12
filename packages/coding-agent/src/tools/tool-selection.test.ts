import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_NAMES, resolveToolSelection } from "./tool-selection.js";

describe("resolveToolSelection", () => {
	it("keeps Edit and Write for GPT models (no auto-replacement)", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const selection = resolveToolSelection(DEFAULT_TOOL_NAMES, model);

		expect(selection.toolNames).toContain("Edit");
		expect(selection.toolNames).toContain("Write");
		expect(selection.replacedWithApplyPatch).toBe(false);
	});

	it("keeps Edit and Write for non-GPT models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const selection = resolveToolSelection(DEFAULT_TOOL_NAMES, model);

		expect(selection.toolNames).toContain("Edit");
		expect(selection.toolNames).toContain("Write");
		expect(selection.replacedWithApplyPatch).toBe(false);
	});
});
