import { describe, expect, it } from "vitest";
import { getToolDescription } from "../src/prompts/index.js";
import { readImageTool } from "../src/tools/read-image.js";

describe("read_image vision guidance", () => {
	it("encourages mode:self for vision models and delegate for non-vision models in the tool description", () => {
		const description = getToolDescription("read_image");
		expect(description).toContain('When the active model supports image input, prefer `mode: "self"`');
		expect(description).toContain('If the active model does not support image input, use `mode: "delegate"`');
	});

	it("mentions vision-based mode guidance in the mode parameter schema", () => {
		const schema = readImageTool.parameters as {
			type: string;
			properties: Record<string, { description?: string }>;
		};

		expect(schema.properties.mode?.description).toContain(
			'When the active model supports image input, prefer `mode: "self"`',
		);
		expect(schema.properties.mode?.description).toContain(
			'If the active model does not support image input, use `mode: "delegate"`',
		);
	});
});
