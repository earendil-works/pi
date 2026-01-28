// Verification: Queue drain pause/resume functionality

import { getModel } from "@kennyfrc/mu-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";

// Mock transport that yields minimal events
class MockTransport {
	async *run() {
		yield { type: "agent_start" };
		yield { type: "turn_start" };
		yield {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "test" }], timestamp: Date.now() },
		};
		yield {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "test" }], timestamp: Date.now() },
		};
		yield {
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "response" }],
				api: "google-generative-ai",
				provider: "google",
				model: "gemini-2.5-flash",
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		};
		yield {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "response" }],
				api: "google-generative-ai",
				provider: "google",
				model: "gemini-2.5-flash",
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		};
		yield { type: "turn_end", message: { role: "assistant", content: [], stopReason: "stop" }, toolResults: [] };
		yield { type: "agent_end", messages: [] };
	}
}

describe("Queue Drain Pause", () => {
	let agent: Agent;

	beforeEach(() => {
		agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [],
			},
			transport: new MockTransport() as any,
		});
	});

	it("should default to not paused", () => {
		expect(agent.isQueueDrainPaused()).toBe(false);
	});

	it("should pause and resume queue drain", () => {
		agent.pauseQueueDrain();
		expect(agent.isQueueDrainPaused()).toBe(true);

		agent.resumeQueueDrain();
		expect(agent.isQueueDrainPaused()).toBe(false);
	});

	it("should preserve queued messages when paused", async () => {
		// Queue a message
		agent.queueMessage("queued message");
		expect(agent.getQueuedMessages().length).toBe(1);

		// Pause drain before prompt
		agent.pauseQueueDrain();

		// Run prompt
		await agent.prompt("test input");

		// Queue should NOT be drained because we paused
		expect(agent.getQueuedMessages().length).toBe(1);

		// Resume drain
		agent.resumeQueueDrain();

		// Queue is still there (will drain on next prompt completion)
		expect(agent.getQueuedMessages().length).toBe(1);
	});

	it("should drain queue normally when not paused", async () => {
		// Queue a message
		agent.queueMessage("queued message");
		expect(agent.getQueuedMessages().length).toBe(1);

		// Run prompt without pausing
		await agent.prompt("test input");

		// Queue should be drained
		expect(agent.getQueuedMessages().length).toBe(0);
	});
});
