import type {
	AgentEvent,
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentRunConfig, AgentTransport } from "../src/transports/types.js";

class InterruptCapturingTransport implements AgentTransport {
	public injectedText: string | null = null;

	async *run(
		_messages: Message[],
		_userMessage: Message,
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent> {
		if (config.interrupt) {
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [],
				stopReason: "toolUse",
				api: "google-generative-ai",
				provider: "google",
				model: "gemini",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};

			const toolResults: ToolResultMessage[] = [
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "noop",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				},
			];

			const injected = await config.interrupt(
				{
					assistantMessage,
					toolResults,
					messages: [],
				},
				signal,
			);

			const first: UserMessage | undefined = injected?.[0];
			if (!first) {
				this.injectedText = null;
			} else if (typeof first.content === "string") {
				this.injectedText = first.content;
			} else {
				const blocks: Array<TextContent | ImageContent> = first.content;
				const firstTextBlock = blocks.find((c): c is TextContent => c.type === "text");
				this.injectedText = firstTextBlock ? firstTextBlock.text : null;
			}
		}

		yield { type: "agent_end", messages: [] };
	}
}

describe("Queue mode steer: dual-queue semantics", () => {
	it("does not reclassify already-queued items when enabling steer", () => {
		const transport = new InterruptCapturingTransport();
		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [],
			},
			transport,
		});

		agent.setQueueMode("one-at-a-time");
		agent.queueMessage("A");

		agent.setQueueMode("steer");
		agent.queueMessage("B");

		expect(agent.getQueuedMessages().map((m) => m.kind)).toEqual(["by-end", "next"]);
	});

	it("interrupt drains only queued-next items (leaves queued-by-end untouched)", async () => {
		const transport = new InterruptCapturingTransport();
		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [],
			},
			transport,
		});

		agent.setQueueMode("one-at-a-time");
		agent.queueMessage("by-end");
		agent.setQueueMode("steer");
		agent.queueMessage("next");

		agent.pauseQueueDrain(); // avoid draining remaining queue after prompt
		await agent.prompt("test input");

		expect(transport.injectedText).toContain("next");
		expect(transport.injectedText).not.toContain("by-end");

		// Only the by-end message should remain queued.
		expect(agent.getQueuedMessages().map((m) => m.text)).toEqual(["by-end"]);
		expect(agent.getQueuedMessages().map((m) => m.kind)).toEqual(["by-end"]);
	});

	it("switching away from steer normalizes queued-next -> queued-by-end", () => {
		const transport = new InterruptCapturingTransport();
		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [],
			},
			transport,
		});

		agent.setQueueMode("steer");
		agent.queueMessage("was-next");
		expect(agent.getQueuedMessages().map((m) => m.kind)).toEqual(["next"]);

		agent.setQueueMode("one-at-a-time");
		expect(agent.getQueuedMessages().map((m) => m.kind)).toEqual(["by-end"]);
	});
});
