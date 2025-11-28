import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent, ProviderTransport } from "../src/index.js";

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent({
			transport: new ProviderTransport(),
		});

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamMessage).toBe(null);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.error).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			transport: new ProviderTransport(),
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("should subscribe to events", () => {
		const agent = new Agent({
			transport: new ProviderTransport(),
		});

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.setSystemPrompt("Test prompt");
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		// Unsubscribe should work
		unsubscribe();
		agent.setSystemPrompt("Another prompt");
		expect(eventCount).toBe(0); // Should not increase
	});

	it("should update state with mutators", () => {
		const agent = new Agent({
			transport: new ProviderTransport(),
		});

		// Test setSystemPrompt
		agent.setSystemPrompt("Custom prompt");
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.setModel(newModel);
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.setThinkingLevel("high");
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools = [{ name: "test", description: "test tool" } as any];
		agent.setTools(tools);
		expect(agent.state.tools).toBe(tools);

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.replaceMessages(messages);
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] };
		agent.appendMessage(newMessage as any);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.clearMessages();
		expect(agent.state.messages).toEqual([]);
	});

	it("should support message queueing", () => {
		const agent = new Agent({
			transport: new ProviderTransport(),
		});

		agent.queueMessage("Queued message");

		// The message is queued but not yet in state.messages
		// (queue is internal, messages only appear after prompt processes them)
		expect(agent.state.messages).toEqual([]);
	});

	it("should handle abort controller", () => {
		const agent = new Agent({
			transport: new ProviderTransport(),
		});

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});
});

describe("ProviderTransport", () => {
	it("should create a provider transport instance", () => {
		const transport = new ProviderTransport();
		expect(transport).toBeDefined();
	});

	it("should create a provider transport with options", () => {
		const transport = new ProviderTransport({
			getApiKey: async (provider) => `test-key-${provider}`,
			corsProxyUrl: "https://proxy.example.com",
		});
		expect(transport).toBeDefined();
	});
});
