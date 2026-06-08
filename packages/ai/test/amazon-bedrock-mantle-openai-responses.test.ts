import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete, getModel, stream } from "../src/compat.ts";
import type { Context, Tool } from "../src/types.ts";
import { StringEnum } from "../src/utils/typebox-helpers.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";

// Amazon Bedrock Mantle exposes the OpenAI Responses API. The registered model
// pins the us-east-2 endpoint (gpt-5.5 is available there only); the API mints
// a short-lived bearer token scoped to that region.
const gpt55 = getModel("amazon-bedrock-mantle-openai-responses", "openai.gpt-5.5");

const calculatorSchema = Type.Object({
	a: Type.Number({ description: "First number" }),
	b: Type.Number({ description: "Second number" }),
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'.",
	}),
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Mantle OpenAI Responses (openai.gpt-5.5)", () => {
	it("should complete basic text generation", { retry: 3 }, async () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant. Be concise.",
			messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
		};
		const response = await complete(gpt55, context);

		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
		expect(response.usage.output).toBeGreaterThan(0);
		expect(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain(
			"Hello test successful",
		);
	});

	it("should stream text deltas", { retry: 3 }, async () => {
		let textStarted = false;
		let textChunks = "";
		let textCompleted = false;

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
		};

		const s = stream(gpt55, context);
		for await (const event of s) {
			if (event.type === "text_start") textStarted = true;
			else if (event.type === "text_delta") textChunks += event.delta;
			else if (event.type === "text_end") textCompleted = true;
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		expect(textStarted).toBe(true);
		expect(textChunks.length).toBeGreaterThan(0);
		expect(textCompleted).toBe(true);
	});

	it("should handle tool calling", { retry: 3 }, async () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant that uses tools when asked.",
			messages: [
				{ role: "user", content: "Calculate 15 + 27 using the math_operation tool.", timestamp: Date.now() },
			],
			tools: [calculatorTool],
		};

		const response = await complete(gpt55, context);
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");
		const toolCall = response.content.find((b) => b.type === "toolCall");
		expect(toolCall, "expected a tool call").toBeTruthy();
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("math_operation");
			expect(toolCall.id).toBeTruthy();
			expect((toolCall.arguments as { a?: number }).a).toBe(15);
			expect((toolCall.arguments as { b?: number }).b).toBe(27);
		}
	});

	it("should complete a tool-use round trip", { retry: 3 }, async () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant that uses tools when asked.",
			messages: [
				{ role: "user", content: "Calculate 15 + 27 using the math_operation tool.", timestamp: Date.now() },
			],
			tools: [calculatorTool],
		};

		const first = await complete(gpt55, context);
		const toolCall = first.content.find((b) => b.type === "toolCall");
		expect(toolCall, `Error: ${first.errorMessage}`).toBeTruthy();
		if (toolCall?.type !== "toolCall") throw new Error("No tool call found");

		context.messages.push(first);
		context.messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "42" }],
			isError: false,
			timestamp: Date.now(),
		});

		const second = await complete(gpt55, context);
		expect(second.stopReason, `Error: ${second.errorMessage}`).not.toBe("error");
		expect(second.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("42");
	});

	it("should emit thinking with reasoning enabled", { retry: 3 }, async () => {
		let thinkingStarted = false;
		let thinkingCompleted = false;

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{
					role: "user",
					content: `Think step by step about ${(Math.random() * 255) | 0} + 27, then output the result.`,
					timestamp: Date.now(),
				},
			],
		};

		const s = stream(gpt55, context, { reasoningEffort: "medium" });
		for await (const event of s) {
			if (event.type === "thinking_start") thinkingStarted = true;
			else if (event.type === "thinking_end") thinkingCompleted = true;
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
		expect(thinkingStarted).toBe(true);
		expect(thinkingCompleted).toBe(true);
		expect(response.content.some((b) => b.type === "thinking")).toBeTruthy();
	});
});
