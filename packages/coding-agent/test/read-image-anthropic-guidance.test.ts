import { describe, expect, it } from "vitest";
import { getToolDescription } from "../src/prompts/index.js";
import { readImageTool } from "../src/tools/read-image.js";

describe("read_image anthropic guidance", () => {
	it("encourages mode:self in the tool description for Anthropic usage", () => {
		const description = getToolDescription("read_image");
		expect(description).toContain('On Anthropic models, prefer `mode: "self"`');
		expect(description).toContain("Claude");
	});

	it("mentions Anthropic self-mode guidance in the mode parameter schema", () => {
		const schema = readImageTool.parameters as {
			type: string;
			properties: Record<string, { description?: string }>;
		};

		expect(schema.properties.mode?.description).toContain('On Anthropic models, prefer `mode: "self"`');
	});
});
