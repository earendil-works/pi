import { describe, expect, it } from "vitest";
import { readImageTool } from "../src/tools/read-image.js";

describe("read_image self mode schema (red)", () => {
	it("exposes an explicit mode selector for delegated vs same-context self reads", () => {
		const schema = readImageTool.parameters as {
			type: string;
			properties: Record<string, { enum?: string[] }>;
		};

		expect(schema.type).toBe("object");
		expect(schema.properties.mode?.enum).toEqual(["delegate", "self"]);
	});
});
