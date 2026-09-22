import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import type { JsonValue, Tool, ToolCall } from "../src/types.ts";
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
		arguments: { value: value as JsonValue },
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

	it("treats null as omission for optional non-nullable properties", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				path: Type.String(),
				offset: Type.Optional(Type.Number()),
				nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({
			path: "file.txt",
			nullable: null,
			metadata: {},
		});
	});

	it("preserves optional nulls whose referenced schema is nullable", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: {
				type: "object",
				properties: { value: { $ref: "#/$defs/value" } },
				$defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
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

	it("coerces a JSON-encoded string into the array or object its schema asks for", () => {
		const cases: Array<{ schema: Tool["parameters"]; input: unknown; expected: unknown }> = [
			{
				schema: { type: "array", items: { type: "string" } } as Tool["parameters"],
				input: '["a","b"]',
				expected: ["a", "b"],
			},
			{
				schema: { type: "array", items: { type: "number" } } as Tool["parameters"],
				input: '["1","2"]',
				expected: [1, 2],
			},
			{
				schema: {
					type: "object",
					properties: { name: { type: "string" }, count: { type: "number" } },
					required: ["name", "count"],
				} as Tool["parameters"],
				input: '{"name":"a","count":"2"}',
				expected: { name: "a", count: 2 },
			},
			{
				schema: {
					oneOf: [
						{ type: "object", properties: { kind: { const: "a" } }, required: ["kind"] },
						{ type: "object", properties: { kind: { const: "b" } }, required: ["kind"] },
					],
				} as Tool["parameters"],
				input: '{"kind":"b"}',
				expected: { kind: "b" },
			},
		];

		for (const testCase of cases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("coerces a JSON-encoded string for native TypeBox array and object schemas", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				tags: Type.Array(Type.String()),
				target: Type.Object({ name: Type.String(), count: Type.Number() }),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { tags: '["a","b"]', target: '{"name":"x","count":"2"}' },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ tags: ["a", "b"], target: { name: "x", count: 2 } });
	});

	it("normalizes optional nulls in a JSON-encoded structure like in a native one", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				value: Type.Object({
					enabled: Type.Optional(Type.Boolean()),
					count: Type.Optional(Type.Number()),
					metadata: Type.Optional(Type.Object({ name: Type.String() })),
					nullable: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
				}),
				items: Type.Array(Type.Object({ enabled: Type.Optional(Type.Boolean()) })),
			}),
		};
		const expected = { value: { nullable: null }, items: [{}] };
		const native: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: {
				value: { enabled: null, count: null, metadata: null, nullable: null },
				items: [{ enabled: null }],
			},
		};
		const encoded: ToolCall = {
			...native,
			arguments: {
				value: '{"enabled":null,"count":null,"metadata":null,"nullable":null}',
				items: '[{"enabled":null}]',
			},
		};

		expect(validateToolArguments(tool, native)).toEqual(expected);
		expect(validateToolArguments(tool, encoded)).toEqual(expected);
	});

	// A union with a string arm keeps a JSON-encoded object as the string it already is.
	it("keeps a JSON-looking string when the schema also accepts a string", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ type: ["string", "object"] } as Tool["parameters"],
			'{"a":1}',
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: '{"a":1}' });
	});

	it("leaves a value alone when the string is not the JSON type the schema asks for", () => {
		const failingCases: Array<{ schema: Tool["parameters"]; input: unknown }> = [
			{ schema: { type: "object", properties: {} } as Tool["parameters"], input: "not json" },
			{ schema: { type: "array", items: { type: "string" } } as Tool["parameters"], input: '{"a":1}' },
			{ schema: { type: "object", properties: {} } as Tool["parameters"], input: "[1,2]" },
			{
				schema: {
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
				} as Tool["parameters"],
				input: '{"other":1}',
			},
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
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
});
