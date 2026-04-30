import { describe, expect, it } from "vitest";
import { convertTools } from "../src/providers/google-shared.js";
import type { Tool } from "../src/types.js";

function makeTool(parameters: Record<string, unknown>): Tool {
	return {
		name: "test_tool",
		description: "A test tool",
		parameters: parameters as Tool["parameters"],
	};
}

describe("google-shared convertTools", () => {
	it("strips JSON Schema meta keys from parameters when useParameters=true", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				$id: "urn:bash-tool",
				$comment: "A bash tool for demonstration",
				$defs: {
					commandDef: { type: "string" },
				},
				definitions: {
					legacyDef: { type: "number" },
				},
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
		expect(decl?.parameters).not.toHaveProperty("$schema");
		expect(decl?.parameters).not.toHaveProperty("$id");
		expect(decl?.parameters).not.toHaveProperty("$comment");
		expect(decl?.parameters).not.toHaveProperty("$defs");
		expect(decl?.parameters).not.toHaveProperty("definitions");
	});

	it("recursively strips nested JSON Schema meta keys", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					deep: {
						$schema: "http://json-schema.org/draft-07/schema#",
						$id: "urn:nested",
						type: "string",
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				deep: {
					type: "string",
				},
			},
		});
	});

	it("preserves $ref while stripping meta keys", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					refProp: {
						$ref: "#/$defs/someDef",
						type: "string",
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				refProp: {
					$ref: "#/$defs/someDef",
					type: "string",
				},
			},
		});
	});

	it("does not mutate the original Tool.parameters object", () => {
		const originalParameters = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		};
		const tools = [makeTool(originalParameters)];

		convertTools(tools, true);

		expect(originalParameters).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
	});

	it("preserves $schema in parametersJsonSchema when useParameters=false", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, false);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parametersJsonSchema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
	});

	it("handles tools without $schema gracefully", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				path: { type: "string" },
			},
			required: ["path"],
		});
	});

	it("returns undefined for empty tool list", () => {
		expect(convertTools([])).toBeUndefined();
		expect(convertTools([], true)).toBeUndefined();
	});
});
