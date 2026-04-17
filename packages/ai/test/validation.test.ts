import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("validateToolArguments", () => {
	it("coerces stringified JSON arrays into real arrays before validation", () => {
		const tool = {
			name: "edit",
			description: "Edit tool",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						oldText: Type.String(),
						newText: Type.String(),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "edit",
			arguments: {
				path: "/tmp/test.ts",
				edits: JSON.stringify([{ oldText: "foo", newText: "bar" }]),
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ oldText: "foo", newText: "bar" }]);
	});

	it("coerces stringified JSON objects into real objects before validation", () => {
		const tool = {
			name: "config",
			description: "Config tool",
			parameters: Type.Object({
				settings: Type.Object({
					verbose: Type.Boolean(),
				}),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "config",
			arguments: {
				settings: JSON.stringify({ verbose: true }),
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.settings).toEqual({ verbose: true });
	});

	it("does not coerce strings that are not valid JSON", () => {
		const tool = {
			name: "edit",
			description: "Edit tool",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(Type.String()),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "edit",
			arguments: {
				path: "/tmp/test.ts",
				edits: "not json at all",
			},
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});

	it("falls back to raw arguments without writing to stderr when runtime code generation is blocked", () => {
		const originalFunction = globalThis.Function;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const tool = {
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
			expect(validateToolArguments(tool, toolCall)).toEqual(toolCall.arguments);
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.Function = originalFunction;
		}
	});
});
