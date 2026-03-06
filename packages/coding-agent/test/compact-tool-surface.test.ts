import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

import { allTools } from "../src/tools/index.js";
import { DEFAULT_TOOL_NAMES, GPT_DEFAULT_TOOL_NAMES, resolveToolSelection } from "../src/tools/tool-selection.js";

describe("compact tool surface", () => {
	it("registers compact instead of handoff in the public tool registry", () => {
		expect(Object.keys(allTools)).toContain("compact");
		expect(Object.keys(allTools)).not.toContain("handoff");
	});

	it("defaults GPT models to compact instead of handoff", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const selection = resolveToolSelection(undefined, model);

		expect(GPT_DEFAULT_TOOL_NAMES).toContain("compact");
		expect(GPT_DEFAULT_TOOL_NAMES).not.toContain("handoff");
		expect(selection.toolNames).toContain("compact");
		expect(selection.toolNames).not.toContain("handoff");
	});

	it("defaults non-GPT models to compact instead of handoff", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const selection = resolveToolSelection(undefined, model);

		expect(DEFAULT_TOOL_NAMES).toContain("compact");
		expect(DEFAULT_TOOL_NAMES).not.toContain("handoff");
		expect(selection.toolNames).toContain("compact");
		expect(selection.toolNames).not.toContain("handoff");
	});
});
