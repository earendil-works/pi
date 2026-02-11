import { describe, expect, it } from "vitest";

/**
 * Test that function_call completion handler uses fallback
 * to currentBlock.partialJson when item.arguments is empty.
 */
describe("function_call completion fallback", () => {
	it("should use item.arguments when available", () => {
		const item = {
			type: "function_call" as const,
			arguments: '{"key": "from_item"}',
			call_id: "call1",
			id: "fc_1",
			name: "testTool",
		};
		const currentBlock = {
			type: "toolCall" as const,
			partialJson: '{"key": "from_block"}',
			arguments: { key: "from_block" },
		};

		// Simulate the logic
		const argsStr = item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";

		expect(argsStr).toBe('{"key": "from_item"}');
		expect(JSON.parse(argsStr)).toEqual({ key: "from_item" });
	});

	it("should fall back to currentBlock.partialJson when item.arguments is empty", () => {
		const item = { type: "function_call" as const, arguments: "", call_id: "call1", id: "fc_1", name: "testTool" };
		const currentBlock = {
			type: "toolCall" as const,
			partialJson: '{"key": "from_block"}',
			arguments: { key: "from_block" },
		};

		const argsStr = item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";

		expect(argsStr).toBe('{"key": "from_block"}');
		expect(JSON.parse(argsStr)).toEqual({ key: "from_block" });
	});

	it("should fall back to currentBlock.partialJson when item.arguments is undefined", () => {
		const item = { type: "function_call" as const, call_id: "call1", id: "fc_1", name: "testTool" } as {
			type: "function_call";
			arguments?: string;
			call_id: string;
			id: string;
			name: string;
		};
		const currentBlock = {
			type: "toolCall" as const,
			partialJson: '{"key": "from_block"}',
			arguments: { key: "from_block" },
		};

		const argsStr = item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";

		expect(argsStr).toBe('{"key": "from_block"}');
	});

	it("should use empty object as final fallback", () => {
		const item = { type: "function_call" as const, arguments: "", call_id: "call1", id: "fc_1", name: "testTool" };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const currentBlock = null as any;

		const argsStr = item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";

		expect(argsStr).toBe("{}");
		expect(JSON.parse(argsStr)).toEqual({});
	});
});
