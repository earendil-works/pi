import { describe, expect, it } from "vitest";
import { convertTools } from "../src/providers/google-shared.js";
import type { Tool } from "../src/types.js";

// Helper to create test tools with plain object schemas (simulating runtime behavior)
function createTestTools(
	tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): Tool[] {
	return tools as unknown as Tool[];
}

describe("google-shared convertTools — schema sanitization for OpenAPI 3.03", () => {
	it("converts anyOf with const values to enum when useParameters=true", () => {
		const tools = createTestTools([
			{
				name: "test_tool",
				description: "A test tool",
				parameters: {
					type: "object",
					properties: {
						type: {
							anyOf: [{ const: "fact" }, { const: "lesson" }],
						},
					},
					required: ["type"],
				},
			},
		]);

		const result = convertTools(tools, true);

		expect(result).toBeTruthy();
		const funcDecl = result![0].functionDeclarations[0];
		expect(funcDecl.name).toBe("test_tool");

		const params = funcDecl.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, unknown>;
		const typeSchema = props.type as Record<string, unknown>;

		// Should be converted to enum, not anyOf
		expect(typeSchema.anyOf).toBeUndefined();
		expect(typeSchema.type).toBe("string");
		expect(typeSchema.enum).toEqual(["fact", "lesson"]);
	});

	it("converts standalone const to single-value enum when useParameters=true", () => {
		const tools = createTestTools([
			{
				name: "test_tool",
				description: "A test tool",
				parameters: {
					type: "object",
					properties: {
						mode: { const: "strict" },
					},
				},
			},
		]);

		const result = convertTools(tools, true);

		const funcDecl = result![0].functionDeclarations[0];
		const params = funcDecl.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, unknown>;
		const modeSchema = props.mode as Record<string, unknown>;

		expect(modeSchema.const).toBeUndefined();
		expect(modeSchema.type).toBe("string");
		expect(modeSchema.enum).toEqual(["strict"]);
	});

	it("preserves original schema when useParameters=false", () => {
		const tools = createTestTools([
			{
				name: "test_tool",
				description: "A test tool",
				parameters: {
					type: "object",
					properties: {
						type: {
							anyOf: [{ const: "fact" }, { const: "lesson" }],
						},
					},
				},
			},
		]);

		const result = convertTools(tools, false);

		const funcDecl = result![0].functionDeclarations[0];
		// When useParameters=false, parametersJsonSchema is used (not parameters)
		const schema = funcDecl.parametersJsonSchema as Record<string, unknown>;
		const props = schema.properties as Record<string, unknown>;
		const typeSchema = props.type as Record<string, unknown>;

		// Should preserve anyOf with const
		expect(typeSchema.anyOf).toEqual([{ const: "fact" }, { const: "lesson" }]);
	});

	it("handles nested objects with anyOf+const", () => {
		const tools = createTestTools([
			{
				name: "nested_tool",
				description: "A tool with nested schema",
				parameters: {
					type: "object",
					properties: {
						config: {
							type: "object",
							properties: {
								level: {
									anyOf: [{ const: "low" }, { const: "medium" }, { const: "high" }],
								},
							},
						},
					},
				},
			},
		]);

		const result = convertTools(tools, true);

		const funcDecl = result![0].functionDeclarations[0];
		const params = funcDecl.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, unknown>;
		const config = props.config as Record<string, unknown>;
		const configProps = config.properties as Record<string, unknown>;
		const level = configProps.level as Record<string, unknown>;

		expect(level.anyOf).toBeUndefined();
		expect(level.type).toBe("string");
		expect(level.enum).toEqual(["low", "medium", "high"]);
	});

	it("preserves mixed anyOf (not all const)", () => {
		const tools = createTestTools([
			{
				name: "mixed_tool",
				description: "A tool with mixed anyOf",
				parameters: {
					type: "object",
					properties: {
						value: {
							anyOf: [{ type: "string" }, { type: "number" }],
						},
					},
				},
			},
		]);

		const result = convertTools(tools, true);

		const funcDecl = result![0].functionDeclarations[0];
		const params = funcDecl.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, unknown>;
		const valueSchema = props.value as Record<string, unknown>;

		// Should preserve anyOf since items are not all const
		expect(valueSchema.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
		expect(valueSchema.enum).toBeUndefined();
	});
});
