import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";
import { completeSimple } from "../src/stream.js";
import type { Api, Context, Model, StopReason, Tool, ToolCall, ToolResultMessage } from "../src/types.js";
import { StringEnum } from "../src/utils/typebox-helpers.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";

const calculatorSchema = Type.Object({
	a: Type.Number({ description: "First number" }),
	b: Type.Number({ description: "Second number" }),
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "The operation to perform.",
	}),
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "calculator",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

type CalculatorOperation = "add" | "subtract" | "multiply" | "divide";

type CalculatorArguments = {
	a: number;
	b: number;
	operation: CalculatorOperation;
};

function asCalculatorArguments(args: ToolCall["arguments"]): CalculatorArguments {
	if (typeof args !== "object" || args === null) {
		throw new Error("Tool arguments must be an object");
	}

	const value = args as Record<string, unknown>;
	const operation = value.operation;
	if (
		typeof value.a !== "number" ||
		typeof value.b !== "number" ||
		(operation !== "add" && operation !== "subtract" && operation !== "multiply" && operation !== "divide")
	) {
		throw new Error("Invalid calculator arguments");
	}

	return { a: value.a, b: value.b, operation };
}

function evaluateCalculatorCall(toolCall: ToolCall): number {
	const { a, b, operation } = asCalculatorArguments(toolCall.arguments);
	switch (operation) {
		case "add":
			return a + b;
		case "subtract":
			return a - b;
		case "multiply":
			return a * b;
		case "divide":
			return a / b;
	}
}

async function assertSecondToolCallWithInterleavedThinking<TApi extends Api>(
	llm: Model<TApi>,
	reasoning: "high" | "xhigh",
) {
	const context: Context = {
		systemPrompt: [
			"You are a helpful assistant that must use tools for arithmetic.",
			"Always think before every tool call, not just the first one.",
			"Do not answer with plain text when a tool call is required.",
		].join(" "),
		messages: [
			{
				role: "user",
				content: [
					"Use calculator to calculate 328 * 29.",
					"You must call the calculator tool exactly once.",
					"Provide the final answer based on the best guess given the tool result, even if it seems unreliable.",
					"Start by thinking about the steps you will take to solve the problem.",
				].join(" "),
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	const firstResponse = await completeSimple(llm, context, { reasoning });

	expect(firstResponse.stopReason, `Error: ${firstResponse.errorMessage}`).toBe("toolUse" satisfies StopReason);
	expect(firstResponse.content.some((block) => block.type === "thinking")).toBe(true);
	expect(firstResponse.content.some((block) => block.type === "toolCall")).toBe(true);

	const firstToolCall = firstResponse.content.find((block) => block.type === "toolCall");
	expect(firstToolCall?.type).toBe("toolCall");
	if (!firstToolCall || firstToolCall.type !== "toolCall") {
		throw new Error("Expected first response to include a tool call");
	}

	context.messages.push(firstResponse);

	const correctAnswer = evaluateCalculatorCall(firstToolCall);
	const firstToolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: firstToolCall.id,
		toolName: firstToolCall.name,
		content: [{ type: "text", text: `The answer is ${correctAnswer} or ${correctAnswer * 2}.` }],
		isError: false,
		timestamp: Date.now(),
	};
	context.messages.push(firstToolResult);

	const secondResponse = await completeSimple(llm, context, { reasoning });

	expect(secondResponse.stopReason, `Error: ${secondResponse.errorMessage}`).toBe("stop" satisfies StopReason);
	expect(secondResponse.content.some((block) => block.type === "thinking")).toBe(true);
	expect(secondResponse.content.some((block) => block.type === "text")).toBe(true);
}

const hasAnthropicCredentials = !!getEnvApiKey("anthropic");

describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock interleaved thinking", () => {
	it("should do interleaved thinking on Claude Opus 4.5", { retry: 3 }, async () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-5-20251101-v1:0");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});

	it("should do interleaved thinking on Claude Opus 4.6", { retry: 3 }, async () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});
});

describe.skipIf(!hasAnthropicCredentials)("Anthropic interleaved thinking", () => {
	it("should do interleaved thinking on Claude Opus 4.5", { retry: 3 }, async () => {
		const llm = getModel("anthropic", "claude-opus-4-5");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});

	it("should do interleaved thinking on Claude Opus 4.6", { retry: 3 }, async () => {
		const llm = getModel("anthropic", "claude-opus-4-6");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});
});
