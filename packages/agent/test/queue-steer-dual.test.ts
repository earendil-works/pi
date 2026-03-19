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
				this.injectedText = stripUserMessageTimePrefix(first.content);
			} else {
				const blocks: Array<TextContent | ImageContent> = first.content;
				this.injectedText = stripUserMessageTimePrefix(
					blocks
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n"),
				);
			}
		}

		yield { type: "agent_end", messages: [] };
	}
}

class RecordingTransport implements AgentTransport {
	public userTexts: string[] = [];

	async *run(
		_messages: Message[],
		userMessage: Message,
		_config: AgentRunConfig,
		_signal?: AbortSignal,
	): AsyncIterable<AgentEvent> {
		const asText = (msg: Message): string => {
			const content = (msg as unknown as { content: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			const blocks = content as Array<TextContent | ImageContent>;
			return blocks
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
		};

		this.userTexts.push(asText(userMessage));
		yield { type: "message_start", message: userMessage };
		yield { type: "message_end", message: userMessage };
		yield { type: "agent_end", messages: [] };
	}
}

const USER_MESSAGE_TIME_PREFIX_PATTERN = /^(?:<user_message_time>[\s\S]*?<\/user_message_time>(?:\n\n|\n)?)+/;

function stripUserMessageTimePrefix(text: string): string {
	return text.replace(USER_MESSAGE_TIME_PREFIX_PATTERN, "");
}

describe("Steer queue: dual-queue semantics", () => {
	it("maintains separate kinds for by-end vs next", () => {
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

		agent.queueMessage("A");
		agent.queueSteerMessage("B");

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

		agent.queueMessage("by-end");
		agent.queueSteerMessage("next");

		agent.pauseQueueDrain(); // avoid draining remaining queue after prompt
		await agent.prompt("test input");

		expect(transport.injectedText).toContain("next");
		expect(transport.injectedText).not.toContain("by-end");

		// Only the by-end message should remain queued.
		expect(agent.getQueuedMessages().map((m) => m.text)).toEqual(["by-end"]);
		expect(agent.getQueuedMessages().map((m) => m.kind)).toEqual(["by-end"]);
	});

	it("prioritizes queued-next over queued-by-end even when queueMode=all", async () => {
		const transport = new RecordingTransport();
		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [],
			},
			queueMode: "all",
			transport,
		});

		agent.queueMessage("BY-END 1");
		agent.queueMessage("BY-END 2");
		agent.queueSteerMessage("NEXT 1");
		agent.queueSteerMessage("NEXT 2");

		await agent.prompt("START");

		const texts = transport.userTexts.map(stripUserMessageTimePrefix);
		expect(texts[0]).toContain("START");
		expect(texts[1]).toContain("NEXT 1");
		expect(texts[2]).toContain("NEXT 2");
		expect(texts[3]).toContain("BY-END 1");
		expect(texts[3]).toContain("BY-END 2");
	});
});
