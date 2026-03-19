import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { resolveToolSelection } from "./tool-selection.js";

describe("resolveToolSelection", () => {
	it("defaults GPT-* models to the GPT tool set", () => {
		const model = getModel("openai", "gpt-5.1-codex");
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
		expect(selection.replacedWithApplyPatch).toBe(true);
	});

	it("keeps Edit and Write for non-GPT models", () => {
		const model = getModel("xai", "grok-code-fast-1");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toContain("edit");
		expect(selection.toolNames).toContain("write");
		expect(selection.toolNames).toContain("spawn_agent");
		expect(selection.replacedWithApplyPatch).toBe(false);
	});

	it("defaults non-GPT models to the regular tool set", () => {
		const model = getModel("xai", "grok-code-fast-1");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"list_threads",
			"read_thread",
			"read_image",
			"spawn_agent",
			"wait_agent",
			"compact",
		]);
	});
});
