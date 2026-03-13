// Verification: Queue drain pause/resume functionality

import type { AgentEvent, ImageContent, Message, TextContent } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentRunConfig, AgentTransport } from "../src/transports/types.js";

const USER_MESSAGE_TIME_PREFIX_PATTERN = /^(?:<user_message_time>[\s\S]*?<\/user_message_time>\n\n)+/;

function stripUserMessageTimePrefix(text: string): string {
	return text.replace(USER_MESSAGE_TIME_PREFIX_PATTERN, "");
}

function readMessageText(message: Message): string {
	const content = (message as unknown as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const blocks = content as Array<TextContent | ImageContent>;
	return blocks
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

class DelayedRecordingTransport implements AgentTransport {
	public userTexts: string[] = [];

	async *run(
		_messages: Message[],
		userMessage: Message,
		_config: AgentRunConfig,
		_signal?: AbortSignal,
	): AsyncIterable<AgentEvent> {
		const userText = stripUserMessageTimePrefix(readMessageText(userMessage));
		this.userTexts.push(userText);

		yield { type: "agent_start" };
		yield { type: "turn_start" };
		yield { type: "message_start", message: userMessage };
		yield { type: "message_end", message: userMessage };

		await sleep(25);

		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: `response:${userText}` }],
			api: "google-generative-ai" as const,
			provider: "google" as const,
			model: "gemini-2.5-flash",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};

		yield { type: "message_start", message: assistantMessage };
		yield { type: "message_end", message: assistantMessage };
		yield { type: "turn_end", message: assistantMessage, toolResults: [] };
		yield { type: "agent_end", messages: [assistantMessage] };
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

	it("should preserve queued messages while paused and drain them after resume", async () => {
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

		await agent.waitForIdle();

		// Resume should wake the preserved queue back up.
		expect(agent.getQueuedMessages().length).toBe(0);
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

	it("should drain queued next and by-end messages after resume when they were queued during a paused prompt", async () => {
		const transport = new DelayedRecordingTransport();
		agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [],
			},
			transport,
		});

		agent.pauseQueueDrain();
		const currentPrompt = agent.prompt("current prompt");

		await sleep(10);
		agent.queueMessage("queued by end");
		agent.queueSteerMessage("queued next");

		await currentPrompt;
		expect(agent.getQueuedMessages().map((m) => ({ text: m.text, kind: m.kind }))).toEqual([
			{ text: "queued by end", kind: "by-end" },
			{ text: "queued next", kind: "next" },
		]);

		agent.resumeQueueDrain();

		await Promise.race([
			agent.waitForIdle(),
			sleep(150).then(() => {
				throw new Error("queue drain did not resume after pause was lifted");
			}),
		]);

		expect(agent.getQueuedMessages()).toHaveLength(0);
		expect(transport.userTexts).toEqual(["current prompt", "queued next", "queued by end"]);
	});
});
