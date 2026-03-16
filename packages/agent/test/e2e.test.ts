import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { calculateTool } from "./utils/calculate.js";

delete process.env.ANTHROPIC_OAUTH_TOKEN;

async function basicPrompt(model: Model<any>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant. Keep your responses concise.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	await agent.prompt("What is 2+2? Answer with just the number.");

	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.messages.length).toBe(2);
	expect(agent.state.messages[0].role).toBe("user");
	expect(agent.state.messages[1].role).toBe("assistant");

	const assistantMessage = agent.state.messages[1];
	if (assistantMessage.role !== "assistant") throw new Error("Expected assistant message");
	expect(assistantMessage.content.length).toBeGreaterThan(0);

	const textContent = assistantMessage.content.find((c) => c.type === "text");
	expect(textContent).toBeDefined();
	if (textContent?.type !== "text") throw new Error("Expected text content");
	expect(textContent.text).toContain("4");
}

async function toolExecution(model: Model<any>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant. Always use the calculator tool for math.",
			model,
			thinkingLevel: "off",
			tools: [calculateTool],
		},
	});

	await agent.prompt("Calculate 123 * 456 using the calculator tool.");

	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.messages.length).toBeGreaterThanOrEqual(3);

	const toolResultMsg = agent.state.messages.find((m) => m.role === "toolResult");
	expect(toolResultMsg).toBeDefined();
	if (toolResultMsg?.role !== "toolResult") throw new Error("Expected tool result message");
	const textContent =
		toolResultMsg.content
			?.filter((c) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || "";
	expect(textContent).toBeDefined();

	const expectedResult = 123 * 456;
	expect(textContent).toContain(String(expectedResult));

	const finalMessage = agent.state.messages[agent.state.messages.length - 1];
	if (finalMessage.role !== "assistant") throw new Error("Expected final assistant message");
	const finalText = finalMessage.content.find((c) => c.type === "text");
	expect(finalText).toBeDefined();
	if (finalText?.type !== "text") throw new Error("Expected text content");
	// Check for number with or without comma formatting
	const hasNumber =
		finalText.text.includes(String(expectedResult)) ||
		finalText.text.includes("56,088") ||
		finalText.text.includes("56088");
	expect(hasNumber).toBe(true);
}

async function abortExecution(model: Model<any>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant.",
			model,
			thinkingLevel: "off",
			tools: [calculateTool],
		},
	});

	const promptPromise = agent.prompt("Calculate 100 * 200, then 300 * 400, then sum the results.");

	setTimeout(() => {
		agent.abort();
	}, 100);

	await promptPromise;

	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.messages.length).toBeGreaterThanOrEqual(2);

	const lastMessage = agent.state.messages[agent.state.messages.length - 1];
	if (lastMessage.role !== "assistant") throw new Error("Expected assistant message");
	expect(lastMessage.stopReason).toBe("aborted");
	expect(lastMessage.errorMessage).toBeDefined();
	expect(agent.state.error).toBeDefined();
	expect(agent.state.error).toBe(lastMessage.errorMessage);
}

async function stateUpdates(model: Model<any>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	const events: Array<string> = [];

	agent.subscribe((event) => {
		events.push(event.type);
	});

	await agent.prompt("Count from 1 to 5.");

	// Should have received lifecycle events
	expect(events).toContain("agent_start");
	expect(events).toContain("agent_end");
	expect(events).toContain("message_start");
	expect(events).toContain("message_end");
	// May have message_update events during streaming
	const hasMessageUpdates = events.some((e) => e === "message_update");
	expect(hasMessageUpdates).toBe(true);

	// Check final state
	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.messages.length).toBe(2); // User message + assistant response
}

async function multiTurnConversation(model: Model<any>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	await agent.prompt("My name is Alice.");
	expect(agent.state.messages.length).toBe(2);

	await agent.prompt("What is my name?");
	expect(agent.state.messages.length).toBe(4);

	const lastMessage = agent.state.messages[3];
	if (lastMessage.role !== "assistant") throw new Error("Expected assistant message");
	const lastText = lastMessage.content.find((c) => c.type === "text");
	if (lastText?.type !== "text") throw new Error("Expected text content");
	expect(lastText.text.toLowerCase()).toContain("alice");
}

describe("Agent E2E Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider (gemini-2.5-flash)", () => {
		const model = getModel("google", "gemini-2.5-flash");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Provider (gpt-4o-mini)", () => {
		const model = getModel("openai", "gpt-4o-mini");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider (claude-haiku-4-5)", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider (grok-3)", () => {
		const model = getModel("xai", "grok-3");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider (openai/gpt-oss-20b)", () => {
		const model = getModel("groq", "openai/gpt-oss-20b");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});

	/*describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider (gpt-oss-120b)", () => {
		const model = getModel("cerebras", "gpt-oss-120b");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});*/

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider (glm-4.5-air)", () => {
		const model = getModel("zai", "glm-4.5-air");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-sonnet-4-5)", () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle basic text prompt", async () => {
			await basicPrompt(model);
		});

		it("should execute tools correctly", async () => {
			await toolExecution(model);
		});

		it("should handle abort during execution", async () => {
			await abortExecution(model);
		});

		it("should emit state updates during streaming", async () => {
			await stateUpdates(model);
		});

		it("should maintain context across multiple turns", async () => {
			await multiTurnConversation(model);
		});
	});
});

describe("Agent.continue()", () => {
	describe("validation", () => {
		it("should throw when no messages in context", async () => {
			const agent = new Agent({
				initialState: {
					systemPrompt: "Test",
					model: getModel("openai", "gpt-5.4"),
				},
			});

			await expect(agent.continue()).rejects.toThrow("No messages to continue from");
		});

		it("should throw when last message is assistant", async () => {
			const agent = new Agent({
				initialState: {
					systemPrompt: "Test",
					model: getModel("openai", "gpt-5.4"),
				},
			});

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			agent.replaceMessages([assistantMessage]);

			await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("continue from user message", () => {
		const model = getModel("openai", "gpt-5.4");

		it("should continue and get response when last message is user", async () => {
			const agent = new Agent({
				initialState: {
					systemPrompt: "You are a helpful assistant. Follow instructions exactly.",
					model,
					thinkingLevel: "off",
					tools: [],
				},
			});

			// Manually add a user message without calling prompt()
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: "Say exactly: HELLO WORLD" }],
				timestamp: Date.now(),
			};
			agent.replaceMessages([userMessage]);

			// Continue from the user message
			await agent.continue();

			expect(agent.state.isStreaming).toBe(false);
			expect(agent.state.messages.length).toBe(2);
			expect(agent.state.messages[0].role).toBe("user");
			expect(agent.state.messages[1].role).toBe("assistant");

			const assistantMsg = agent.state.messages[1] as AssistantMessage;
			const textContent = assistantMsg.content.find((c) => c.type === "text");
			expect(textContent).toBeDefined();
			if (textContent?.type === "text") {
				expect(textContent.text.toUpperCase()).toContain("HELLO WORLD");
			}
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("continue from tool result", () => {
		const model = getModel("openai", "gpt-5.4");

		it("should continue and process tool results", async () => {
			const agent = new Agent({
				initialState: {
					systemPrompt:
						"You are a helpful assistant. After getting a calculation result, state the answer clearly.",
					model,
					thinkingLevel: "off",
					tools: [calculateTool],
				},
			});

			// Set up a conversation state as if tool was just executed
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: "What is 5 + 3?" }],
				timestamp: Date.now(),
			};

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "text", text: "Let me calculate that." },
					{ type: "toolCall", id: "calc-1", name: "calculate", arguments: { expression: "5 + 3" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};

			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "calc-1",
				toolName: "calculate",
				content: [{ type: "text", text: "5 + 3 = 8" }],
				isError: false,
				timestamp: Date.now(),
			};

			agent.replaceMessages([userMessage, assistantMessage, toolResult]);

			// Continue from the tool result
			await agent.continue();

			expect(agent.state.isStreaming).toBe(false);
			// Should have added an assistant response
			expect(agent.state.messages.length).toBeGreaterThanOrEqual(4);

			const lastMessage = agent.state.messages[agent.state.messages.length - 1];
			expect(lastMessage.role).toBe("assistant");

			if (lastMessage.role === "assistant") {
				const textContent = lastMessage.content
					.filter((c) => c.type === "text")
					.map((c) => (c as { type: "text"; text: string }).text)
					.join(" ");
				// Should mention 8 in the response
				expect(textContent).toMatch(/8/);
			}
		});
	});
});
