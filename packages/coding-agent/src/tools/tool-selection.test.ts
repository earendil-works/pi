import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { resolveToolSelection } from "./tool-selection.js";

describe("resolveToolSelection", () => {
	it("defaults GPT-ish models to the standard tool set, but swaps edit -> apply_patch", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toEqual([
			"read",
			"bash",
			"apply_patch",
			"write",
			"list_threads",
			"read_thread",
			"read_image",
			"todo",
			"handoff",
		]);
		expect(selection.replacedWithApplyPatch).toBe(true);
	});

	it("keeps Edit and Write for non-GPT models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toContain("edit");
		expect(selection.toolNames).toContain("write");
		expect(selection.replacedWithApplyPatch).toBe(false);
	});
});
