import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("validateToolArguments", () => {
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

	it("returns raw arguments and logs warning when ajv.compile throws", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Use a schema with an unresolvable $ref to force ajv.compile to throw
		const tool = {
			name: "broken",
			description: "Tool with bad schema",
			parameters: { $ref: "nonexistent" } as unknown as ReturnType<typeof Type.Object>,
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-2",
			name: "broken",
			arguments: { foo: "bar" },
		};

		const result = validateToolArguments(tool, toolCall);

		expect(result).toEqual(toolCall.arguments);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('AJV schema compilation failed for tool "broken"'));
	});

	it("validates and coerces arguments when ajv.compile succeeds", () => {
		const tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-3",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		const result = validateToolArguments(tool, toolCall);

		// coerceTypes: true should convert "42" to 42
		expect(result).toEqual({ count: 42 });
	});

	it("throws on invalid arguments when ajv.compile succeeds", () => {
		const tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-4",
			name: "echo",
			arguments: { count: "not-a-number" },
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow('Validation failed for tool "echo"');
	});
});
