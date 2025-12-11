import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Message, Model, Tool, ToolResultMessage } from "../src/types.js";

// Tool for testing
const weatherSchema = Type.Object({
	location: Type.String({ description: "City name" }),
});

const weatherTool: Tool<typeof weatherSchema> = {
	name: "get_weather",
	description: "Get the weather for a location",
	parameters: weatherSchema,
};

// Pre-built contexts representing typical outputs from each provider
const providerContexts = {
	// Anthropic-style message with thinking block
	anthropic: {
		message: {
			role: "assistant",
			api: "anthropic-messages",
			content: [
				{
					type: "thinking",
					thinking: "Let me calculate 17 * 23. That's 17 * 20 + 17 * 3 = 340 + 51 = 391",
					thinkingSignature: "signature_abc123",
				},
				{
					type: "text",
					text: "I'll help you with the calculation and check the weather. The result of 17 × 23 is 391. The capital of Austria is Vienna. Now let me check the weather for you.",
				},
				{
					type: "toolCall",
					id: "toolu_01abc123",
					name: "get_weather",
					arguments: { location: "Tokyo" },
				},
			],
			provider: "anthropic",
			model: "claude-3-5-haiku-latest",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "toolu_01abc123",
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in Tokyo: 18°C, partly cloudy" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 391,
			city: "Tokyo",
			temperature: 18,
			capital: "Vienna",
		},
	},

	// Google-style message with thinking
	google: {
		message: {
			role: "assistant",
			api: "google-generative-ai",
			content: [
				{
					type: "thinking",
					thinking:
						"I need to multiply 19 * 24. Let me work through this: 19 * 24 = 19 * 20 + 19 * 4 = 380 + 76 = 456",
					thinkingSignature: undefined,
				},
				{
					type: "text",
					text: "The multiplication of 19 × 24 equals 456. The capital of France is Paris. Let me check the weather in Berlin for you.",
				},
				{
					type: "toolCall",
					id: "call_gemini_123",
					name: "get_weather",
					arguments: { location: "Berlin" },
				},
			],
			provider: "google",
			model: "gemini-2.5-flash",
			usage: {
				input: 120,
				output: 60,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "call_gemini_123",
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in Berlin: 22°C, sunny" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 456,
			city: "Berlin",
			temperature: 22,
			capital: "Paris",
		},
	},

	// OpenAI Completions style (with reasoning_content)
	openaiCompletions: {
		message: {
			role: "assistant",
			api: "openai-completions",
			content: [
				{
					type: "thinking",
					thinking: "Let me calculate 21 * 25. That's 21 * 25 = 525",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "text",
					text: "The result of 21 × 25 is 525. The capital of Spain is Madrid. I'll check the weather in London now.",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "get_weather",
					arguments: { location: "London" },
				},
			],
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 110,
				output: 55,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "call_abc123",
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in London: 15°C, rainy" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 525,
			city: "London",
			temperature: 15,
			capital: "Madrid",
		},
	},

	// OpenAI Responses style (with complex tool call IDs)
	openaiResponses: {
		message: {
			role: "assistant",
			api: "openai-responses",
			content: [
				{
					type: "thinking",
					thinking: "Calculating 18 * 27: 18 * 27 = 486",
					thinkingSignature:
						'{"type":"reasoning","id":"rs_2b2342acdde","summary":[{"type":"summary_text","text":"Calculating 18 * 27: 18 * 27 = 486"}]}',
				},
				{
					type: "text",
					text: "The calculation of 18 × 27 gives us 486. The capital of Italy is Rome. Let me check Sydney's weather.",
					textSignature: "msg_response_456",
				},
				{
					type: "toolCall",
					id: "call_789_item_012", // Anthropic requires alphanumeric, dash, and underscore only
					name: "get_weather",
					arguments: { location: "Sydney" },
				},
			],
			provider: "openai",
			model: "gpt-5-mini",
			usage: {
				input: 115,
				output: 58,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "call_789_item_012", // Match the updated ID format
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in Sydney: 25°C, clear" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 486,
			city: "Sydney",
			temperature: 25,
			capital: "Rome",
		},
	},

	// Aborted message (stopReason: 'error')
	aborted: {
		message: {
			role: "assistant",
			api: "anthropic-messages",
			content: [
				{
					type: "thinking",
					thinking: "Let me start calculating 20 * 30...",
					thinkingSignature: "partial_sig",
				},
				{
					type: "text",
					text: "I was about to calculate 20 × 30 which is",
				},
			],
			provider: "test",
			model: "test-model",
			usage: {
				input: 50,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: null,
		facts: {
			calculation: 600,
			city: "none",
			temperature: 0,
			capital: "none",
		},
	},
};

/**
 * Test that a provider can handle contexts from different sources
 */
async function testProviderHandoff<TApi extends Api>(
	targetModel: Model<TApi>,
	sourceLabel: string,
	sourceContext: (typeof providerContexts)[keyof typeof providerContexts],
): Promise<boolean> {
	// Build conversation context
	const messages: Message[] = [
		{
			role: "user",
			content: "Please do some calculations, tell me about capitals, and check the weather.",
			timestamp: Date.now(),
		},
		sourceContext.message,
	];

	// Add tool result if present
	if (sourceContext.toolResult) {
		messages.push(sourceContext.toolResult);
	}

	// Ask follow-up question
	messages.push({
		role: "user",
		content: `Based on our conversation, please answer:
                 1) What was the multiplication result?
                 2) Which city's weather did we check?
                 3) What was the temperature?
                 4) What capital city was mentioned?
                 Please include the specific numbers and names.`,
		timestamp: Date.now(),
	});

	const context: Context = {
		messages,
		tools: [weatherTool],
	};

	try {
		const response = await complete(targetModel, context, {});

		// Check for error
		if (response.stopReason === "error") {
			console.log(`[${sourceLabel} → ${targetModel.provider}] Failed with error: ${response.errorMessage}`);
			return false;
		}

		// Extract text from response
		const responseText = response.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join(" ")
			.toLowerCase();

		// For aborted messages, we don't expect to find the facts
		if (sourceContext.message.stopReason === "error") {
			const hasToolCalls = response.content.some((b) => b.type === "toolCall");
			const hasThinking = response.content.some((b) => b.type === "thinking");
			const hasText = response.content.some((b) => b.type === "text");

			expect(response.stopReason === "stop" || response.stopReason === "toolUse").toBe(true);
			expect(hasThinking || hasText || hasToolCalls).toBe(true);
			console.log(
				`[${sourceLabel} → ${targetModel.provider}] Handled aborted message successfully, tool calls: ${hasToolCalls}, thinking: ${hasThinking}, text: ${hasText}`,
			);
			return true;
		}

		// Check if response contains our facts
		const hasCalculation = responseText.includes(sourceContext.facts.calculation.toString());
		const hasCity =
			sourceContext.facts.city !== "none" && responseText.includes(sourceContext.facts.city.toLowerCase());
		const hasTemperature =
			sourceContext.facts.temperature > 0 && responseText.includes(sourceContext.facts.temperature.toString());
		const hasCapital =
			sourceContext.facts.capital !== "none" && responseText.includes(sourceContext.facts.capital.toLowerCase());

		const success = hasCalculation && hasCity && hasTemperature && hasCapital;

		console.log(`[${sourceLabel} → ${targetModel.provider}] Handoff test:`);
		if (!success) {
			console.log(`  Calculation (${sourceContext.facts.calculation}): ${hasCalculation ? "✓" : "✗"}`);
			console.log(`  City (${sourceContext.facts.city}): ${hasCity ? "✓" : "✗"}`);
			console.log(`  Temperature (${sourceContext.facts.temperature}): ${hasTemperature ? "✓" : "✗"}`);
			console.log(`  Capital (${sourceContext.facts.capital}): ${hasCapital ? "✓" : "✗"}`);
		} else {
			console.log(`  ✓ All facts found`);
		}

		return success;
	} catch (error) {
		console.error(`[${sourceLabel} → ${targetModel.provider}] Exception:`, error);
		return false;
	}
}

describe("Cross-Provider Handoff Tests", () => {
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Handoff", () => {
		const model = getModel("anthropic", "claude-3-5-haiku-20241022");

		it("should handle contexts from all providers", async () => {
			console.log("\nTesting Anthropic with pre-built contexts:\n");

			const contextTests = [
				{ label: "Anthropic-style", context: providerContexts.anthropic, sourceModel: "claude-3-5-haiku-20241022" },
				{ label: "Google-style", context: providerContexts.google, sourceModel: "gemini-2.5-flash" },
				{ label: "OpenAI-Completions", context: providerContexts.openaiCompletions, sourceModel: "gpt-4o-mini" },
				{ label: "OpenAI-Responses", context: providerContexts.openaiResponses, sourceModel: "gpt-5-mini" },
				{ label: "Aborted", context: providerContexts.aborted, sourceModel: null },
			];

			let successCount = 0;
			let skippedCount = 0;

			for (const { label, context, sourceModel } of contextTests) {
				// Skip testing same model against itself
				if (sourceModel && sourceModel === model.id) {
					console.log(`[${label} → ${model.provider}] Skipping same-model test`);
					skippedCount++;
					continue;
				}
				const success = await testProviderHandoff(model, label, context);
				if (success) successCount++;
			}

			const totalTests = contextTests.length - skippedCount;
			console.log(`\nAnthropic success rate: ${successCount}/${totalTests} (${skippedCount} skipped)\n`);

			// All non-skipped handoffs should succeed
			expect(successCount).toBe(totalTests);
		});
	});

	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Handoff", () => {
		const model = getModel("google", "gemini-2.5-flash");

		it("should handle contexts from all providers", async () => {
			console.log("\nTesting Google with pre-built contexts:\n");

			const contextTests = [
				{ label: "Anthropic-style", context: providerContexts.anthropic, sourceModel: "claude-3-5-haiku-20241022" },
				{ label: "Google-style", context: providerContexts.google, sourceModel: "gemini-2.5-flash" },
				{ label: "OpenAI-Completions", context: providerContexts.openaiCompletions, sourceModel: "gpt-4o-mini" },
				{ label: "OpenAI-Responses", context: providerContexts.openaiResponses, sourceModel: "gpt-5-mini" },
				{ label: "Aborted", context: providerContexts.aborted, sourceModel: null },
			];

			let successCount = 0;
			let skippedCount = 0;

			for (const { label, context, sourceModel } of contextTests) {
				// Skip testing same model against itself
				if (sourceModel && sourceModel === model.id) {
					console.log(`[${label} → ${model.provider}] Skipping same-model test`);
					skippedCount++;
					continue;
				}
				const success = await testProviderHandoff(model, label, context);
				if (success) successCount++;
			}

			const totalTests = contextTests.length - skippedCount;
			console.log(`\nGoogle success rate: ${successCount}/${totalTests} (${skippedCount} skipped)\n`);

			// All non-skipped handoffs should succeed
			expect(successCount).toBe(totalTests);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Handoff", () => {
		const model: Model<"openai-completions"> = { ...getModel("openai", "gpt-4o-mini"), api: "openai-completions" };

		it("should handle contexts from all providers", async () => {
			console.log("\nTesting OpenAI Completions with pre-built contexts:\n");

			const contextTests = [
				{ label: "Anthropic-style", context: providerContexts.anthropic, sourceModel: "claude-3-5-haiku-20241022" },
				{ label: "Google-style", context: providerContexts.google, sourceModel: "gemini-2.5-flash" },
				{ label: "OpenAI-Completions", context: providerContexts.openaiCompletions, sourceModel: "gpt-4o-mini" },
				{ label: "OpenAI-Responses", context: providerContexts.openaiResponses, sourceModel: "gpt-5-mini" },
				{ label: "Aborted", context: providerContexts.aborted, sourceModel: null },
			];

			let successCount = 0;
			let skippedCount = 0;

			for (const { label, context, sourceModel } of contextTests) {
				// Skip testing same model against itself
				if (sourceModel && sourceModel === model.id) {
					console.log(`[${label} → ${model.provider}] Skipping same-model test`);
					skippedCount++;
					continue;
				}
				const success = await testProviderHandoff(model, label, context);
				if (success) successCount++;
			}

			const totalTests = contextTests.length - skippedCount;
			console.log(`\nOpenAI Completions success rate: ${successCount}/${totalTests} (${skippedCount} skipped)\n`);

			// All non-skipped handoffs should succeed
			expect(successCount).toBe(totalTests);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Handoff", () => {
		const model = getModel("openai", "gpt-5-mini");

		it("should handle contexts from all providers", async () => {
			console.log("\nTesting OpenAI Responses with pre-built contexts:\n");

			const contextTests = [
				{ label: "Anthropic-style", context: providerContexts.anthropic, sourceModel: "claude-3-5-haiku-20241022" },
				{ label: "Google-style", context: providerContexts.google, sourceModel: "gemini-2.5-flash" },
				{ label: "OpenAI-Completions", context: providerContexts.openaiCompletions, sourceModel: "gpt-4o-mini" },
				{ label: "OpenAI-Responses", context: providerContexts.openaiResponses, sourceModel: "gpt-5-mini" },
				{ label: "Aborted", context: providerContexts.aborted, sourceModel: null },
			];

			let successCount = 0;
			let skippedCount = 0;

			for (const { label, context, sourceModel } of contextTests) {
				// Skip testing same model against itself
				if (sourceModel && sourceModel === model.id) {
					console.log(`[${label} → ${model.provider}] Skipping same-model test`);
					skippedCount++;
					continue;
				}
				const success = await testProviderHandoff(model, label, context);
				if (success) successCount++;
			}

			const totalTests = contextTests.length - skippedCount;
			console.log(`\nOpenAI Responses success rate: ${successCount}/${totalTests} (${skippedCount} skipped)\n`);

			// All non-skipped handoffs should succeed
			expect(successCount).toBe(totalTests);
		});
	});
});
