import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogle } from "../src/api/google-generative-ai.ts";
import {
	convertTools,
	resolveGoogleFunctionCallingMode,
	supportsGoogleStrictToolSampling,
} from "../src/api/google-shared.ts";
import { streamSimple as streamSimpleVertex } from "../src/api/google-vertex.ts";
import type { GoogleCompat, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function googleModel(id: string, compat?: GoogleCompat): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "test-google",
		baseUrl: "https://example.invalid/v1beta",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(compat && { compat }),
	};
}

function vertexModel(id: string, compat?: GoogleCompat): Model<"google-vertex"> {
	return {
		...googleModel(id, compat),
		api: "google-vertex",
		provider: "test-vertex",
		baseUrl: "https://example.invalid/v1",
	};
}

/** Builds the request for one strict-preferring tool and returns its function-calling mode. */
async function capturedFunctionCallingMode(
	model: Model<"google-generative-ai"> | Model<"google-vertex">,
): Promise<string | undefined> {
	const tool = makeTool({ type: "object", properties: {} });
	tool.constrainedSampling = { type: "json_schema", strict: "prefer" };
	const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }], tools: [tool] });
	let payload: GenerateContentParameters | undefined;
	const onPayload = (request: unknown) => {
		payload = request as GenerateContentParameters;
		throw new Error("payload captured");
	};
	const stream =
		model.api === "google-vertex"
			? streamSimpleVertex(model as Model<"google-vertex">, context, { apiKey: "test", onPayload })
			: streamSimpleGoogle(model as Model<"google-generative-ai">, context, { apiKey: "test", onPayload });
	const result = await stream.result();
	expect(result.errorMessage).toContain("payload captured");
	return payload?.config?.toolConfig?.functionCallingConfig?.mode;
}

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

	it("uses validated function calling for strict tools on Gemini 3", () => {
		const tool = makeTool({ type: "object", properties: {} });
		tool.constrainedSampling = { type: "json_schema", strict: "require" };

		expect(supportsGoogleStrictToolSampling(googleModel("gemini-3.1-pro-preview"))).toBe(true);
		expect(supportsGoogleStrictToolSampling(googleModel("gemini-2.5-pro"))).toBe(false);
		expect(resolveGoogleFunctionCallingMode([tool], undefined, true)).toBe("VALIDATED");
		expect(() => resolveGoogleFunctionCallingMode([tool], undefined, false)).toThrow(
			'Tool "test_tool" requires JSON-schema constrained sampling',
		);
	});

	// #12321
	it("detects prefixed Gemini 3+ IDs and lets compat.supportsStrictMode override the detection", () => {
		expect(supportsGoogleStrictToolSampling(googleModel("randomprefix-gemini-4-argon"))).toBe(true);
		expect(supportsGoogleStrictToolSampling(googleModel("vendor-gemini-2.5-pro"))).toBe(false);
		expect(supportsGoogleStrictToolSampling(googleModel("argon-latest"))).toBe(false);
		expect(supportsGoogleStrictToolSampling(googleModel("argon-latest", { supportsStrictMode: true }))).toBe(true);
		expect(
			supportsGoogleStrictToolSampling(googleModel("gemini-3.1-pro-preview", { supportsStrictMode: false })),
		).toBe(false);
	});

	// #12321
	it("sends VALIDATED for prefixed Gemini 3+ IDs and for compat.supportsStrictMode", async () => {
		for (const makeModel of [googleModel, vertexModel]) {
			expect(await capturedFunctionCallingMode(makeModel("randomprefix-gemini-4-argon"))).toBe("VALIDATED");
			expect(await capturedFunctionCallingMode(makeModel("argon-latest"))).toBeUndefined();
			expect(await capturedFunctionCallingMode(makeModel("argon-latest", { supportsStrictMode: true }))).toBe(
				"VALIDATED",
			);
		}
	});

	it("returns undefined for empty tool list", () => {
		expect(convertTools([])).toBeUndefined();
		expect(convertTools([], true)).toBeUndefined();
	});
});

// Regression coverage for #11308.
describe("google-shared convertTools const handling", () => {
	it.each(["default", "examples", "enum", "const", "x-custom"])("preserves literal data under %s", (key) => {
		const literal = { const: "literal-data", properties: { nested: { const: 1 } } };
		const parameters = {
			type: "object",
			properties: { value: { type: "object", [key]: key === "enum" || key === "examples" ? [literal] : literal } },
		};
		const original = structuredClone(parameters);

		expect(convertTools([makeTool(parameters)])?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema).toEqual(
			original,
		);
		expect(parameters).toEqual(original);
	});

	it.each(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"])(
		"preserves names while rewriting schemas in %s",
		(key) => {
			const parameters = {
				type: "object",
				[key]: {
					["__proto__"]: { const: "x" },
					const: { const: "y" },
					properties: { const: "z" },
				},
			};
			const original = structuredClone(parameters);
			const expected = {
				type: "object",
				[key]: {
					["__proto__"]: { enum: ["x"] },
					const: { enum: ["y"] },
					properties: { enum: ["z"] },
				},
			};

			const result = convertTools([makeTool(parameters)])?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema;
			expect(result).toEqual(expected);
			expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
			expect(parameters).toEqual(original);
		},
	);

	it("rewrites only schema-bearing keywords", () => {
		const parameters = {
			type: "object",
			additionalProperties: { const: "x" },
			unevaluatedProperties: false,
			propertyNames: { const: "name" },
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
			allOf: [{ if: { const: "x" }, then: { const: "y" }, else: { not: { const: "z" } } }],
			properties: {
				list: {
					type: "array",
					items: [{ const: 1 }],
					prefixItems: [{ const: 2 }],
					additionalItems: { const: 3 },
					contains: { const: 4 },
					unevaluatedItems: { const: 5 },
				},
			},
			dependencies: { list: ["other"] },
		};

		expect(convertTools([makeTool(parameters)])?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema).toEqual({
			type: "object",
			additionalProperties: { enum: ["x"] },
			unevaluatedProperties: false,
			propertyNames: { enum: ["name"] },
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
			allOf: [{ if: { enum: ["x"] }, then: { enum: ["y"] }, else: { not: { enum: ["z"] } } }],
			properties: {
				list: {
					type: "array",
					items: [{ enum: [1] }],
					prefixItems: [{ enum: [2] }],
					additionalItems: { enum: [3] },
					contains: { enum: [4] },
					unevaluatedItems: { enum: [5] },
				},
			},
			dependencies: { list: ["other"] },
		});
	});

	it("rewrites string and number const values to single-value enums in parametersJsonSchema", () => {
		const parameters = {
			type: "object",
			properties: {
				origin: { type: "string", const: "zq-src-7" },
				mode: {
					anyOf: [
						{ type: "string", const: "a" },
						{ type: "string", const: "b" },
					],
				},
				level: { oneOf: [{ const: 1 }, { const: 2 }] },
				flag: { type: "boolean", const: true },
				list: { type: "array", items: { const: "x" } },
				const: { type: "string" },
			},
			required: ["origin"],
		};
		const tools = [makeTool(parameters)];

		const result = convertTools(tools);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl?.parametersJsonSchema).toEqual({
			type: "object",
			properties: {
				origin: { type: "string", enum: ["zq-src-7"] },
				mode: { type: "string", enum: ["a", "b"] },
				level: { oneOf: [{ enum: [1] }, { enum: [2] }] },
				flag: { type: "boolean", const: true },
				list: { type: "array", items: { enum: ["x"] } },
				const: { type: "string" },
			},
			required: ["origin"],
		});
		expect(parameters.properties.origin).toEqual({ type: "string", const: "zq-src-7" });
	});
});
