import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

describe("edit tool strict opt-in", () => {
	it("opts into strict tool use and survives wrapping into an AgentTool", () => {
		const definition = createEditToolDefinition("/tmp");
		expect(definition.strict).toBe(true);
		expect(wrapToolDefinition(definition).strict).toBe(true);
	});
});
