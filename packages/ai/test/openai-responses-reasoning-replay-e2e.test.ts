import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete, getEnvApiKey } from "../src/stream.js";
import type { AssistantMessage, Context, Message, Tool, ToolCall } from "../src/types.js";

const testToolSchema = Type.Object({
	value: Type.Number({ description: "A number to double" }),
});

const testTool: Tool<typeof testToolSchema> = {
	name: "double_number",
	description: "Doubles a number and returns the result",
	parameters: testToolSchema,
};

describe.skipIf(!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY)(
	"OpenAI Responses reasoning replay e2e",
	() => {
		it("skips reasoning-only history after an aborted turn", { retry: 2 }, async () => {
			const model = getModel("openai", "gpt-5-mini");

			const apiKey = getEnvApiKey("openai");
			if (!apiKey) {
				throw new Error("Missing OPENAI_API_KEY");
			}

			const userMessage: Message = {
				role: "user",
				content: "Use the double_number tool to double 21.",
				timestamp: Date.now(),
			};

			const assistantResponse = await complete(
				model,
				{
					systemPrompt: "You are a helpful assistant. Use the tool.",
					messages: [userMessage],
					tools: [testTool],
				},
				{
					apiKey,
					reasoningEffort: "high",
				},
			);

			const thinkingBlock = assistantResponse.content.find(
				(block) => block.type === "thinking" && block.thinkingSignature,
			);
			if (!thinkingBlock || thinkingBlock.type !== "thinking") {
				throw new Error("Missing thinking signature from OpenAI Responses");
			}

			const corruptedAssistant: AssistantMessage = {
				...assistantResponse,
				content: [thinkingBlock],
				stopReason: "aborted",
			};

			const followUp: Message = {
				role: "user",
				content: "Say hello to confirm you can continue.",
				timestamp: Date.now(),
			};

			const context: Context = {
				systemPrompt: "You are a helpful assistant.",
				messages: [userMessage, corruptedAssistant, followUp],
				tools: [testTool],
			};

			const response = await complete(model, context, {
				apiKey,
				reasoningEffort: "high",
			});

			// The key assertion: no 400 error from orphaned reasoning item
			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(response.errorMessage).toBeFalsy();
			// Model should respond (text or tool call)
			expect(response.content.length).toBeGreaterThan(0);
		});

		it("handles same-provider different-model handoff with tool calls", { retry: 2 }, async () => {
			// This tests the scenario where:
			// 1. Model A (gpt-5-mini) generates reasoning + function_call
			// 2. User switches to Model B (gpt-5.2-codex) - same provider, different model
			// 3. transform-messages: isSameModel=false, thinking converted to text
			// 4. But tool call ID still has OpenAI pairing history (fc_xxx paired with rs_xxx)
			// 5. Without fix: OpenAI returns 400 "function_call without required reasoning item"
			// 6. With fix: tool calls/results converted to text, conversation continues

			const modelA = getModel("openai", "gpt-5-mini");
			const modelB = getModel("openai", "gpt-5.2-codex");

			const apiKey = getEnvApiKey("openai");
			if (!apiKey) {
				throw new Error("Missing OPENAI_API_KEY");
			}

			const userMessage: Message = {
				role: "user",
				content: "Use the double_number tool to double 21.",
				timestamp: Date.now(),
			};

			// Get a real response from Model A with reasoning + tool call
			const assistantResponse = await complete(
				modelA,
				{
					systemPrompt: "You are a helpful assistant. Always use the tool when asked.",
					messages: [userMessage],
					tools: [testTool],
				},
				{
					apiKey,
					reasoningEffort: "high",
				},
			);

			const toolCallBlock = assistantResponse.content.find((block) => block.type === "toolCall") as
				| ToolCall
				| undefined;

			if (!toolCallBlock) {
				throw new Error("Missing tool call from OpenAI Responses - model did not use the tool");
			}

			// Provide a tool result
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCallBlock.id,
				toolName: toolCallBlock.name,
				content: [{ type: "text", text: "42" }],
				isError: false,
				timestamp: Date.now(),
			};

			const followUp: Message = {
				role: "user",
				content: "What was the result? Answer with just the number.",
				timestamp: Date.now(),
			};

			// Now continue with Model B (different model, same provider)
			const context: Context = {
				systemPrompt: "You are a helpful assistant. Answer concisely.",
				messages: [userMessage, assistantResponse, toolResult, followUp],
				tools: [testTool],
			};

			let capturedPayload: any = null;
			const response = await complete(modelB, context, {
				apiKey,
				reasoningEffort: "high",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			// The key assertion: no 400 error from orphaned function_call
			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(response.errorMessage).toBeFalsy();
			expect(response.content.length).toBeGreaterThan(0);

			// Log what was sent for debugging
			const input = capturedPayload?.input as any[];
			const functionCalls = input?.filter((item: any) => item.type === "function_call") || [];
			const reasoningItems = input?.filter((item: any) => item.type === "reasoning") || [];

			console.log("Payload sent to API:");
			console.log("- function_calls:", functionCalls.length);
			console.log("- reasoning items:", reasoningItems.length);
			console.log("- full input:", JSON.stringify(input, null, 2));

			// Verify the model understood the context
			const responseText = response.content
				.filter((b) => b.type === "text")
				.map((b) => (b as any).text)
				.join("");
			expect(responseText).toContain("42");
		});

		it("handles cross-provider handoff from Anthropic to OpenAI Codex", { retry: 2 }, async () => {
			// This tests cross-provider handoff:
			// 1. Anthropic model generates thinking + function_call (toolu_xxx ID)
			// 2. User switches to OpenAI Codex
			// 3. transform-messages: isSameModel=false, thinking converted to text
			// 4. Tool call ID is Anthropic format (toolu_xxx), no OpenAI pairing history
			// 5. Should work because foreign IDs have no pairing expectation

			const anthropicModel = getModel("anthropic", "claude-sonnet-4-5");
			const codexModel = getModel("openai", "gpt-5.2-codex");

			const anthropicApiKey = getEnvApiKey("anthropic");
			const openaiApiKey = getEnvApiKey("openai");
			if (!anthropicApiKey || !openaiApiKey) {
				throw new Error("Missing API keys");
			}

			const userMessage: Message = {
				role: "user",
				content: "Use the double_number tool to double 21.",
				timestamp: Date.now(),
			};

			// Get a real response from Anthropic with thinking + tool call
			const assistantResponse = await complete(
				anthropicModel,
				{
					systemPrompt: "You are a helpful assistant. Always use the tool when asked.",
					messages: [userMessage],
					tools: [testTool],
				},
				{
					apiKey: anthropicApiKey,
					thinkingEnabled: true,
					thinkingBudgetTokens: 5000,
				},
			);

			const toolCallBlock = assistantResponse.content.find((block) => block.type === "toolCall") as
				| ToolCall
				| undefined;

			if (!toolCallBlock) {
				throw new Error("Missing tool call from Anthropic - model did not use the tool");
			}

			console.log("Anthropic tool call ID:", toolCallBlock.id);

			// Provide a tool result
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCallBlock.id,
				toolName: toolCallBlock.name,
				content: [{ type: "text", text: "42" }],
				isError: false,
				timestamp: Date.now(),
			};

			const followUp: Message = {
				role: "user",
				content: "What was the result? Answer with just the number.",
				timestamp: Date.now(),
			};

			// Now continue with Codex (different provider)
			const context: Context = {
				systemPrompt: "You are a helpful assistant. Answer concisely.",
				messages: [userMessage, assistantResponse, toolResult, followUp],
				tools: [testTool],
			};

			let capturedPayload: any = null;
			const response = await complete(codexModel, context, {
				apiKey: openaiApiKey,
				reasoningEffort: "high",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			// Log what was sent
			const input = capturedPayload?.input as any[];
			const functionCalls = input?.filter((item: any) => item.type === "function_call") || [];
			const reasoningItems = input?.filter((item: any) => item.type === "reasoning") || [];

			console.log("Payload sent to Codex:");
			console.log("- function_calls:", functionCalls.length);
			console.log("- reasoning items:", reasoningItems.length);
			if (functionCalls.length > 0) {
				console.log(
					"- function_call IDs:",
					functionCalls.map((fc: any) => fc.id),
				);
			}

			// The key assertion: no 400 error
			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(response.errorMessage).toBeFalsy();
			expect(response.content.length).toBeGreaterThan(0);

			// Verify the model understood the context
			const responseText = response.content
				.filter((b) => b.type === "text")
				.map((b) => (b as any).text)
				.join("");
			expect(responseText).toContain("42");
		});
	},
);
