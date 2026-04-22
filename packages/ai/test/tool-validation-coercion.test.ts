import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { coerceStringEncodedObjects, formatSchemaInfo, validateToolArguments } from "../src/utils/validation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCall(name: string, arguments_: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: "test-id", name, arguments: arguments_ };
}

function makeTool(schema: Record<string, unknown>): Tool {
	return {
		name: "test_tool",
		description: "test",
		parameters: schema as any,
	};
}

// ---------------------------------------------------------------------------
// coerceStringEncodedObjects
// ---------------------------------------------------------------------------

describe("coerceStringEncodedObjects", () => {
	it("should coerce a string-encoded object property when schema expects object", () => {
		const schema = Type.Object({
			config: Type.Object({ key: Type.String() }),
		});

		const args = {
			config: '{"key": "value"}',
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result.config).toEqual({ key: "value" });
	});

	it("should coerce a string-encoded object property in a single-variant schema", () => {
		const schema = Type.Object({
			startup: Type.Object({ type: Type.String({ enum: ["context"] }), specPath: Type.String() }),
		});

		const args = {
			startup: '{"type": "context", "specPath": "specs/test.md"}',
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result.startup).toEqual({ type: "context", specPath: "specs/test.md" });
	});

	it("should coerce string-encoded items in an array of objects", () => {
		const itemSchema = Type.Object({ id: Type.String(), name: Type.String() });
		const schema = Type.Object({
			items: Type.Array(itemSchema),
		});

		const args = {
			items: ['{"id": "1", "name": "first"}', '{"id": "2", "name": "second"}'],
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result.items).toEqual([
			{ id: "1", name: "first" },
			{ id: "2", name: "second" },
		]);
	});

	it("should leave valid objects untouched", () => {
		const schema = Type.Object({
			config: Type.Object({ key: Type.String() }),
		});

		const args = {
			config: { key: "value" },
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result.config).toEqual({ key: "value" });
	});

	it("should leave string properties that the schema expects to be strings", () => {
		const schema = Type.Object({
			message: Type.String(),
		});

		const args = {
			message: "hello world",
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result.message).toBe("hello world");
	});

	it("should leave non-JSON strings as-is when schema expects object", () => {
		const schema = Type.Object({
			config: Type.Object({ key: Type.String() }),
		});

		const args = {
			config: "not valid json{{{",
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result.config).toBe("not valid json{{{");
	});

	it("should leave JSON strings that parse to non-objects as-is", () => {
		const schema = Type.Object({
			config: Type.Object({ key: Type.String() }),
		});

		const args = {
			config: '"just a string"',
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		// JSON.parse returns "just a string" which is a string, not an object
		expect(result.config).toBe('"just a string"');
	});

	it("should recurse into nested object properties", () => {
		const innerSchema = Type.Object({ value: Type.String() });
		const schema = Type.Object({
			outer: Type.Object({
				inner: innerSchema,
			}),
		});

		const args = {
			outer: {
				inner: '{"value": "coerced"}',
			},
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect((result.outer as Record<string, unknown>).inner).toEqual({ value: "coerced" });
	});

	it("should handle mixed: some array items are objects, some are strings to coerce", () => {
		const itemSchema = Type.Object({ id: Type.String() });
		const schema = Type.Object({
			items: Type.Array(itemSchema),
		});

		const args = {
			items: [{ id: "already-object" }, '{"id": "was-string"}'],
		};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result.items).toEqual([{ id: "already-object" }, { id: "was-string" }]);
	});

	it("should not crash on missing properties or null values", () => {
		const schema = Type.Object({
			config: Type.Object({ key: Type.String() }),
		});

		const args = {};

		const result = coerceStringEncodedObjects(args, schema as unknown as Record<string, unknown>);
		expect(result).toEqual({});
	});

	it("should handle the full spawn_agent-style schema", () => {
		const contextStartupSchema = Type.Object({
			type: Type.String({ enum: ["context"] }),
			specPath: Type.String(),
		});

		const spawnAgentStartupSchema = contextStartupSchema;

		const spawnAgentSchema = Type.Object({
			message: Type.Optional(Type.String()),
			startup: Type.Optional(spawnAgentStartupSchema),
			verificationChecks: Type.Array(Type.String(), { minItems: 1 }),
		});

		// The exact scenario from the bug report
		const args = {
			message: "Implement the task",
			startup: '{"type": "context", "specPath": "specs/worktree-ready.md"}',
			verificationChecks: ["check1", "check2"],
		};

		const result = coerceStringEncodedObjects(args, spawnAgentSchema as unknown as Record<string, unknown>);
		expect(result.startup).toEqual({ type: "context", specPath: "specs/worktree-ready.md" });
		expect(result.message).toBe("Implement the task");
		expect(result.verificationChecks).toEqual(["check1", "check2"]);
	});

	it("should handle the ask_user-style schema (array of object items)", () => {
		const questionSchema = Type.Object({
			id: Type.String({ minLength: 1 }),
			prompt: Type.String({ minLength: 1 }),
			topic: Type.String({ minLength: 1 }),
			options: Type.Array(Type.String(), { default: [] }),
			allowCustom: Type.Optional(Type.Boolean()),
		});

		const askUserSchema = Type.Object({
			mode: Type.Union([
				Type.Literal("validation_contract"),
				Type.Literal("specification"),
				Type.Literal("clarify"),
			]),
			objective: Type.String({ minLength: 1 }),
			questions: Type.Array(questionSchema, { minItems: 1, maxItems: 6 }),
		});

		const args = {
			mode: "clarify",
			objective: "Need info",
			questions: [
				'{"id": "q1", "prompt": "What?", "topic": "design", "options": []}',
				{ id: "q2", prompt: "How?", topic: "impl", options: [] },
			],
		};

		const result = coerceStringEncodedObjects(args, askUserSchema as unknown as Record<string, unknown>);
		expect(result.questions).toEqual([
			{ id: "q1", prompt: "What?", topic: "design", options: [] },
			{ id: "q2", prompt: "How?", topic: "impl", options: [] },
		]);
	});
});

// ---------------------------------------------------------------------------
// validateToolArguments integration with coercion
// ---------------------------------------------------------------------------

describe("validateToolArguments with string-encoded coercion", () => {
	const contextStartupSchema = Type.Object({
		type: Type.String({ enum: ["context"] }),
		specPath: Type.String(),
	});

	const spawnAgentStartupSchema = contextStartupSchema;

	const spawnAgentSchema = Type.Object({
		message: Type.Optional(Type.String()),
		startup: Type.Optional(spawnAgentStartupSchema),
		verificationChecks: Type.Array(Type.String(), { minItems: 1 }),
	});

	it("should accept correctly-typed object arguments", () => {
		const tool = makeTool(spawnAgentSchema);
		const toolCall = makeToolCall("spawn_agent", {
			message: "Do the thing",
			startup: { type: "context", specPath: "specs/test.md" },
			verificationChecks: ["check1"],
		});

		const result = validateToolArguments(tool, toolCall);
		expect(result.startup).toEqual({ type: "context", specPath: "specs/test.md" });
	});

	it("should coerce string-encoded startup and pass validation", () => {
		const tool = makeTool(spawnAgentSchema);
		const toolCall = makeToolCall("spawn_agent", {
			message: "Do the thing",
			startup: '{"type": "context", "specPath": "specs/test.md"}',
			verificationChecks: ["check1"],
		});

		// Without coercion, this would throw "startup: must be object"
		const result = validateToolArguments(tool, toolCall);
		expect(result.startup).toEqual({ type: "context", specPath: "specs/test.md" });
	});

	it("should still reject truly invalid arguments after coercion attempt", () => {
		const tool = makeTool(spawnAgentSchema);
		const toolCall = makeToolCall("spawn_agent", {
			startup: "not-even-json{{{",
			verificationChecks: ["check1"],
		});

		// The string isn't valid JSON, so coercion leaves it as-is,
		// and AJV will reject it
		expect(() => validateToolArguments(tool, toolCall)).toThrow(/Validation failed/);
	});
});

// ---------------------------------------------------------------------------
// formatSchemaInfo with anyOf/union support
// ---------------------------------------------------------------------------

describe("formatSchemaInfo with union types", () => {
	it("should describe anyOf properties with their variants", () => {
		const schema = Type.Object({
			startup: Type.Union([Type.Object({ type: Type.String({ enum: ["context"] }), specPath: Type.String() })]),
		});

		const info = formatSchemaInfo(schema as unknown as Record<string, unknown>);
		expect(info).toContain("startup");
		expect(info).toMatch(/object/);
	});

	it("should describe enum-typed properties", () => {
		const schema = Type.Object({
			mode: Type.String({ enum: ["a", "b", "c"] }),
		});

		const info = formatSchemaInfo(schema as unknown as Record<string, unknown>);
		expect(info).toContain("mode");
		expect(info).toMatch(/a.*b.*c|enum/);
	});

	it("should include required fields", () => {
		const schema = Type.Object({
			name: Type.String(),
			value: Type.String(),
		});

		const info = formatSchemaInfo(schema as unknown as Record<string, unknown>);
		expect(info).toContain("Required:");
		expect(info).toMatch(/name/);
	});

	it("should describe array-of-object properties", () => {
		const schema = Type.Object({
			questions: Type.Array(Type.Object({ id: Type.String() })),
		});

		const info = formatSchemaInfo(schema as unknown as Record<string, unknown>);
		expect(info).toContain("questions");
		expect(info).toMatch(/array|object/);
	});
});
