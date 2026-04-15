import { describe, expect, it } from "vitest";
import { convertTools } from "../src/providers/google-shared.js";
import type { Tool } from "../src/types.js";

describe("google-shared convertTools", () => {
	it("strips JSON Schema meta keys from parameters when useParameters=true", () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "Execute bash commands",
				parameters: {
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
				} as any,
			},
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeTruthy();
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

	it("preserves $ref while stripping meta keys", () => {
		const tools: Tool[] = [
			{
				name: "nested",
				description: "Tool with nested meta keys",
				parameters: {
					$schema: "http://json-schema.org/draft-07/schema#",
					type: "object",
					properties: {
						refProp: {
							$ref: "#/$defs/someDef",
							type: "string",
						},
					},
				} as any,
			},
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeTruthy();
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

	it("preserves $schema in parametersJsonSchema when useParameters=false", () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "Execute bash commands",
				parameters: {
					$schema: "http://json-schema.org/draft-07/schema#",
					type: "object",
					properties: {
						command: { type: "string" },
					},
					required: ["command"],
				} as any,
			},
		];

		const result = convertTools(tools, false);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeTruthy();
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
		const tools: Tool[] = [
			{
				name: "ls",
				description: "List directory contents",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
					},
					required: ["path"],
				} as any,
			},
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeTruthy();
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
