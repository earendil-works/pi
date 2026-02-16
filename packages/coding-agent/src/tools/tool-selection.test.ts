import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { resolveToolSelection } from "./tool-selection.js";

describe("resolveToolSelection", () => {
	it("defaults GPT-* models to a restricted tool set", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toEqual(["exec_command", "read_image", "handoff", "list_threads", "read_thread"]);
		expect(selection.replacedWithApplyPatch).toBe(false);
	});

	it("keeps Edit and Write for non-GPT models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const selection = resolveToolSelection(undefined, model);

		expect(selection.toolNames).toContain("edit");
		expect(selection.toolNames).toContain("write");
		expect(selection.replacedWithApplyPatch).toBe(false);
	});

	it("defaults non-GPT-* OpenAI models to the GPT-ish standard tool set", () => {
		const model = getModel("openai", "codex-mini-latest");
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
	});
});
