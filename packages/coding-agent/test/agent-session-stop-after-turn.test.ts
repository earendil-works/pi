import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
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
}

describe("AgentSession.stopAfterTurn", () => {
	it("should stop the active run after the current turn and preserve follow-ups", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let llmCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "off",
			},
			streamFn: () => {
				llmCalls += 1;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(`response-${llmCalls}`),
					});
				});
				return stream;
			},
		});

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			await session.followUp("continue later");
			session.stopAfterTurn();

			await session.prompt("hello");

			expect(llmCalls).toBe(1);
			expect(session.pendingMessageCount).toBeGreaterThan(0);

			await session.agent.continue();

			expect(llmCalls).toBe(2);
			expect(session.pendingMessageCount).toBe(0);
		} finally {
			session.dispose();
		}
	});
});
