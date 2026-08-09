import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("preserves a value that already matches a nullable union arm", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				value: Type.Union([Type.Number(), Type.Null()]),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("preserves a value that already matches a oneOf nullable union arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ oneOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			null,
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("still coerces nullable unions when the original value does not match any arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ anyOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			"42",
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: 42 });
	});

	it("accepts null for nullable array schemas with items", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ type: ["array", "null"], items: { type: "string" } } as Tool["parameters"],
			null,
		);
		// The CSP test above selects TypeBox's process-wide interpreted fallback, so exercise the generated validator explicitly.
		const generatedCheck = new Function(Compile(tool.parameters).Code())() as (value: unknown) => boolean;

		expect(generatedCheck(toolCall.arguments)).toBe(true);
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1" },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0" },
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});

	it("repairs a JSON-serialized object string for an object-typed property", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{
				type: "object",
				properties: { inline: { type: "string" }, version: { type: "integer" } },
				required: ["inline"],
				additionalProperties: false,
			} as Tool["parameters"],
			'{"inline":"echo hi","version":"2"}',
		);

		// Nested primitive coercion still applies to the parsed value.
		expect(validateToolArguments(tool, toolCall)).toEqual({
			value: { inline: "echo hi", version: 2 },
		});
	});

	it("repairs a JSON-serialized array string for an array-typed property", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ type: "array", items: { type: "integer" } } as Tool["parameters"],
			'["1", 2]',
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: [1, 2] });
	});

	it("still rejects non-JSON strings for object-typed properties", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{
				type: "object",
				properties: { inline: { type: "string" } },
				additionalProperties: false,
			} as Tool["parameters"],
			'\n<parameter name="inline">cd /repo\necho hi',
		);

		expect(() => validateToolArguments(tool, toolCall)).toThrow("must be object");
	});

	it("rejects a JSON object string that does not validate the object schema", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{
				type: "object",
				properties: { inline: { type: "string" } },
				required: ["inline"],
				additionalProperties: false,
			} as Tool["parameters"],
			'{"weird":true}',
		);

		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});

	it("prefers a validating object member over a string member in unions", () => {
		const unionSchema = {
			anyOf: [
				{
					type: "object",
					properties: { inline: { type: "string" } },
					required: ["inline"],
					additionalProperties: false,
				},
				{ type: "string" },
			],
		} as Tool["parameters"];

		const serialized = createToolCallWithPlainSchema(unionSchema, '{"inline":"echo hi"}');
		expect(validateToolArguments(serialized.tool, serialized.toolCall)).toEqual({
			value: { inline: "echo hi" },
		});

		// Ordinary strings and JSON not matching the object member keep the
		// string member.
		const plain = createToolCallWithPlainSchema(unionSchema, "just a plain command");
		expect(validateToolArguments(plain.tool, plain.toolCall)).toEqual({
			value: "just a plain command",
		});

		const mismatched = createToolCallWithPlainSchema(unionSchema, '{"weird":true}');
		expect(validateToolArguments(mismatched.tool, mismatched.toolCall)).toEqual({
			value: '{"weird":true}',
		});
	});

	it("repairs JSON-serialized object strings for TypeBox schemas", () => {
		// TypeBox schemas skip the generic pre-check coercion, so the repair
		// must also run as a last-chance pass after validation fails.
		const tool: Tool = {
			name: "spawn",
			description: "Spawn tool",
			parameters: Type.Object(
				{
					script: Type.Object(
						{
							inline: Type.Optional(Type.String({ minLength: 1 })),
							artifactId: Type.Optional(Type.String({ minLength: 1 })),
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "spawn",
			arguments: { script: '{"inline":"echo hi"}' },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({
			script: { inline: "echo hi" },
		});

		const garbage: ToolCall = {
			...toolCall,
			arguments: { script: '\n<parameter name="inline">cd /repo' },
		};
		expect(() => validateToolArguments(tool, garbage)).toThrow("must be object");
	});
});
