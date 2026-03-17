import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model } from "../src/types.js";

const mockModel: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	contextWindow: 128000,
	maxTokens: 16384,
	input: ["text", "image"],
	cost: {
		input: 0.5,
		output: 1.5,
		cacheRead: 0.25,
		cacheWrite: 0.625,
	},
	reasoning: true,
	headers: {},
};

describe("Empty reasoning summary fix", () => {
	it("should keep empty thinking blocks in transformMessages for same model", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "" }, // Empty thinking
				{ type: "text", text: "Hello" },
			],
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5-mini",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const messages: Message[] = [assistantMsg];
		const transformed = transformMessages(messages, mockModel);

		// Should keep empty thinking block for same model
		const assistantOut = transformed[0] as AssistantMessage;
		expect(assistantOut.content.length).toBe(2);
		expect(assistantOut.content[0].type).toBe("thinking");
		expect((assistantOut.content[0] as any).thinking).toBe("");
	});

	it("should strip fc_xxx IDs when hasSkippedThinking is true", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "" }, // Empty thinking (skipped reasoning)
				{
					type: "toolCall",
					id: "call_123|fc_456",
					name: "test_tool",
					arguments: {},
				},
			],
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5-mini",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const context = {
			systemPrompt: "Test",
			messages: [assistantMsg],
			tools: [],
		};

		const allowedProviders = new Set(["openai", "openai-codex", "opencode"]);
		const result = convertResponsesMessages(mockModel, context, allowedProviders);

		// Find the function_call in the output
		const functionCall = result.find((item: any) => item.type === "function_call") as any;
		expect(functionCall).toBeDefined();
		// The fc_xxx ID should be stripped because hasSkippedThinking is true
		expect(functionCall?.id).toBeUndefined();
		expect(functionCall?.call_id).toBe("call_123");
	});

	it("should not strip fc_xxx IDs when thinking is not empty", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Some reasoning" }, // Non-empty thinking
				{
					type: "toolCall",
					id: "call_123|fc_456",
					name: "test_tool",
					arguments: {},
				},
			],
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5-mini",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const context = {
			systemPrompt: "Test",
			messages: [assistantMsg],
			tools: [],
		};

		const allowedProviders = new Set(["openai", "openai-codex", "opencode"]);
		const result = convertResponsesMessages(mockModel, context, allowedProviders);

		// Find the function_call in the output
		const functionCall = result.find((item: any) => item.type === "function_call") as any;
		expect(functionCall).toBeDefined();
		// The fc_xxx ID should be kept because thinking is not empty
		expect(functionCall?.id).toBe("fc_456");
		expect(functionCall?.call_id).toBe("call_123");
	});
});
