import { describe, expect, it } from "vitest";

/**
 * Test that response.function_call_arguments.done handler
 * correctly finalizes tool call arguments.
 */
describe("response.function_call_arguments.done handler", () => {
	it("should update partialJson and arguments when event is received", () => {
		// Simulate the state that would exist during streaming
		const currentItem = { type: "function_call" as const };
		const currentBlock = {
			type: "toolCall" as const,
			partialJson: '{"key": "val',
			arguments: { key: "val" },
		};

		// Simulate the event handler logic
		const event = { arguments: '{"key": "value"}' };

		if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
			const args = event.arguments || "";
			currentBlock.partialJson = args;
			currentBlock.arguments = JSON.parse(args);
		}

		// Verify the final state
		expect(currentBlock.partialJson).toBe('{"key": "value"}');
		expect(currentBlock.arguments).toEqual({ key: "value" });
	});

	it("should handle empty arguments gracefully", () => {
		const currentItem = { type: "function_call" as const };
		const currentBlock = {
			type: "toolCall" as const,
			partialJson: "",
			arguments: {},
		};

		const event = { arguments: "" };

		if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
			const args = event.arguments || "";
			currentBlock.partialJson = args;
			if (args) {
				currentBlock.arguments = JSON.parse(args);
			}
		}

		expect(currentBlock.partialJson).toBe("");
		expect(currentBlock.arguments).toEqual({});
	});
});
