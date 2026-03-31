import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Model,
	registerFauxProvider,
	type ToolResultMessage,
	type UserMessage,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../src/index.js";
import { calculateTool } from "./utils/calculate.js";

const registrations: FauxProviderRegistration[] = [];

function createFauxRegistration(options: Parameters<typeof registerFauxProvider>[0] = {}): FauxProviderRegistration {
	const registration = registerFauxProvider(options);
	registrations.push(registration);
	return registration;
}

function getTextContent(message: AssistantMessage | ToolResultMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

afterEach(() => {
	while (registrations.length > 0) {
		registrations.pop()?.unregister();
	}
});

async function basicPrompt(model: Model<string>) {
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
	expect(getTextContent(assistantMessage)).toContain("4");
}

async function toolExecution(model: Model<string>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant. Always use the calculator tool for math.",
			model,
			thinkingLevel: "off",
			tools: [calculateTool],
		},
	});

	const pendingToolCallsDuringEvents: Array<{ type: AgentEvent["type"]; ids: string[] }> = [];
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			pendingToolCallsDuringEvents.push({
				type: event.type,
				ids: [...agent.state.pendingToolCalls],
			});
		}
	});

	await agent.prompt("Calculate 123 * 456 using the calculator tool.");

	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.messages.length).toBeGreaterThanOrEqual(4);
	const toolResultMsg = agent.state.messages.find((message) => message.role === "toolResult");
	expect(toolResultMsg).toBeDefined();
	if (toolResultMsg?.role !== "toolResult") throw new Error("Expected tool result message");
	expect(getTextContent(toolResultMsg)).toContain("123 * 456 = 56088");

	const finalMessage = agent.state.messages[agent.state.messages.length - 1];
	if (finalMessage.role !== "assistant") throw new Error("Expected final assistant message");
	expect(getTextContent(finalMessage)).toContain("56088");
	expect(agent.state.pendingToolCalls.size).toBe(0);
	expect(pendingToolCallsDuringEvents).toEqual([
		{ type: "tool_execution_start", ids: ["calc-1"] },
		{ type: "tool_execution_end", ids: [] },
	]);
}

async function abortExecution(model: Model<string>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	const promptPromise = agent.prompt("Count slowly from 1 to 20.");
	setTimeout(() => {
		agent.abort();
	}, 30);

	await promptPromise;

	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.messages.length).toBeGreaterThanOrEqual(2);

	const lastMessage = agent.state.messages[agent.state.messages.length - 1];
	if (lastMessage.role !== "assistant") throw new Error("Expected assistant message");
	expect(lastMessage.stopReason).toBe("aborted");
	expect(lastMessage.errorMessage).toBeDefined();
	expect(agent.state.errorMessage).toBe(lastMessage.errorMessage);
}

async function stateUpdates(model: Model<string>) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	const events: AgentEvent["type"][] = [];
	agent.subscribe((event) => {
		events.push(event.type);
	});

	await agent.prompt("Count from 1 to 5.");

	expect(events).toContain("agent_start");
	expect(events).toContain("turn_start");
	expect(events).toContain("message_start");
	expect(events).toContain("message_update");
	expect(events).toContain("message_end");
	expect(events).toContain("turn_end");
	expect(events).toContain("agent_end");
	expect(events.indexOf("agent_start")).toBeLessThan(events.indexOf("message_start"));
	expect(events.indexOf("message_start")).toBeLessThan(events.indexOf("message_end"));
	expect(events.indexOf("message_end")).toBeLessThan(events.lastIndexOf("agent_end"));

	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.messages.length).toBe(2);
}

async function multiTurnConversation(model: Model<string>) {
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
	expect(getTextContent(lastMessage).toLowerCase()).toContain("alice");
}

describe("Agent integration with faux provider", () => {
	it("handles a basic text prompt", async () => {
		const faux = createFauxRegistration();
		faux.setResponses([fauxAssistantMessage("4")]);
		await basicPrompt(faux.getModel());
	});

	it("executes tools and tracks pending tool calls", async () => {
		const faux = createFauxRegistration();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxText("Let me calculate that."),
					fauxToolCall("calculate", { expression: "123 * 456" }, { id: "calc-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The result is 56088."),
		]);
		await toolExecution(faux.getModel());
	});

	it("handles abort during streaming", async () => {
		const faux = createFauxRegistration({
			tokensPerSecond: 20,
			tokenSize: { min: 2, max: 2 },
		});
		faux.setResponses([
			fauxAssistantMessage(
				"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
			),
		]);
		await abortExecution(faux.getModel());
	});

	it("emits lifecycle updates while streaming", async () => {
		const faux = createFauxRegistration({ tokenSize: { min: 1, max: 1 } });
		faux.setResponses([fauxAssistantMessage("1 2 3 4 5")]);
		await stateUpdates(faux.getModel());
	});

	it("maintains context across multiple turns", async () => {
		const faux = createFauxRegistration();
		faux.setResponses([
			fauxAssistantMessage("Nice to meet you, Alice."),
			(context) => {
				const hasAlice = context.messages.some((message) => {
					if (message.role !== "user") return false;
					if (typeof message.content === "string") return message.content.includes("Alice");
					return message.content.some((block) => block.type === "text" && block.text.includes("Alice"));
				});
				return fauxAssistantMessage(hasAlice ? "Your name is Alice." : "I do not know your name.");
			},
		]);
		await multiTurnConversation(faux.getModel());
	});

	it("preserves thinking content blocks", async () => {
		const faux = createFauxRegistration({ models: [{ id: "faux-reasoning", reasoning: true }] });
		faux.setResponses([fauxAssistantMessage([fauxThinking("step by step"), fauxText("4")])]);

		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: faux.getModel(),
				thinkingLevel: "low",
				tools: [],
			},
		});

		await agent.prompt("What is 2+2?");

		const assistantMessage = agent.state.messages[1];
		if (assistantMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(assistantMessage.content).toEqual([
			{ type: "thinking", thinking: "step by step" },
			{ type: "text", text: "4" },
		]);
	});
});

describe("Agent.continue() with faux provider", () => {
	describe("validation", () => {
		it("throws when no messages in context", async () => {
			const faux = createFauxRegistration();
			const agent = new Agent({
				initialState: {
					systemPrompt: "Test",
					model: faux.getModel(),
				},
			});

			await expect(agent.continue()).rejects.toThrow("No messages to continue from");
		});

		it("throws when last message is assistant", async () => {
			const faux = createFauxRegistration();
			const model = faux.getModel();
			const agent = new Agent({
				initialState: {
					systemPrompt: "Test",
					model,
				},
			});

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
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
			agent.state.messages = [assistantMessage];

			await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
		});
	});

	describe("continue from user message", () => {
		it("continues and gets a response when last message is user", async () => {
			const faux = createFauxRegistration();
			faux.setResponses([fauxAssistantMessage("HELLO WORLD")]);
			const agent = new Agent({
				initialState: {
					systemPrompt: "You are a helpful assistant. Follow instructions exactly.",
					model: faux.getModel(),
					thinkingLevel: "off",
					tools: [],
				},
			});

			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: "Say exactly: HELLO WORLD" }],
				timestamp: Date.now(),
			};
			agent.state.messages = [userMessage];

			await agent.continue();

			expect(agent.state.isStreaming).toBe(false);
			expect(agent.state.messages.length).toBe(2);
			expect(agent.state.messages[0].role).toBe("user");
			expect(agent.state.messages[1].role).toBe("assistant");

			const assistantMsg = agent.state.messages[1];
			if (assistantMsg.role !== "assistant") throw new Error("Expected assistant message");
			expect(getTextContent(assistantMsg).toUpperCase()).toContain("HELLO WORLD");
		});
	});

	describe("continue from tool result", () => {
		it("continues and processes tool results", async () => {
			const faux = createFauxRegistration();
			const model = faux.getModel();
			faux.setResponses([fauxAssistantMessage("The answer is 8.")]);
			const agent = new Agent({
				initialState: {
					systemPrompt:
						"You are a helpful assistant. After getting a calculation result, state the answer clearly.",
					model,
					thinkingLevel: "off",
					tools: [calculateTool],
				},
			});

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
				api: model.api,
				provider: model.provider,
				model: model.id,
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

			agent.state.messages = [userMessage, assistantMessage, toolResult];

			await agent.continue();

			expect(agent.state.isStreaming).toBe(false);
			expect(agent.state.messages.length).toBeGreaterThanOrEqual(4);

			const lastMessage = agent.state.messages[agent.state.messages.length - 1];
			expect(lastMessage.role).toBe("assistant");
			if (lastMessage.role !== "assistant") throw new Error("Expected assistant message");
			expect(getTextContent(lastMessage)).toContain("8");
		});
	});
});
