import { describe, expect, it } from "vitest";
import { createMcpResultSchema } from "../src/index.ts";

describe("createMcpResultSchema", () => {
	it("declares the CallToolResult, with any structured content without an output schema", () => {
		const schema = createMcpResultSchema(undefined) as {
			properties: Record<string, unknown>;
			required: string[];
			additionalProperties: boolean;
		};
		expect(Object.keys(schema.properties)).toEqual(["content", "structuredContent", "isError"]);
		expect(schema.properties.structuredContent).toEqual({});
		expect(schema.required).toEqual(["content"]);
		expect(schema.additionalProperties).toBe(true);
	});

	it("moves the output schema's local references below structuredContent, keeping data and remote references", () => {
		const hit = { type: "object", properties: { id: { type: "string" } } };
		const schema = createMcpResultSchema({
			type: "object",
			properties: {
				hits: { type: "array", items: { $ref: "#/$defs/Hit" } },
				children: { type: "array", items: { $ref: "#" } },
				// A property named like a keyword: its value is a schema.
				default: { $ref: "#/definitions/Hit" },
				remote: { $ref: "https://example.com/schema.json" },
			},
			$defs: { Hit: { ...hit, default: { $ref: "#/stays" } } },
			definitions: { Hit: hit },
		}) as { properties: { structuredContent: Record<string, Record<string, Record<string, unknown>>> } };
		const moved = schema.properties.structuredContent;
		const at = "#/properties/structuredContent";
		expect(moved.properties.hits).toEqual({ type: "array", items: { $ref: `${at}/$defs/Hit` } });
		expect(moved.properties.children).toEqual({ type: "array", items: { $ref: at } });
		expect(moved.properties.default).toEqual({ $ref: `${at}/definitions/Hit` });
		expect(moved.properties.remote).toEqual({ $ref: "https://example.com/schema.json" });
		expect(moved.$defs.Hit.default).toEqual({ $ref: "#/stays" });
	});
});
