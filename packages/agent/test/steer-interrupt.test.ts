import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentTool,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	UserMessage,
} from "@kennyfrc/mu-ai";
import { agentLoop, getModel } from "@kennyfrc/mu-ai";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.js";

import { Agent } from "../src/agent.js";
import type { AgentRunConfig, AgentTransport } from "../src/transports/types.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeStreamFn() {
	let callCount = 0;

	return (model: Model<any>, context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream => {
		callCount++;
		const s = new AssistantMessageEventStream();

		const hasSteer = context.messages.some((msg) => {
			if (msg.role !== "user") return false;
			return typeof msg.content === "string"
				? msg.content.includes("STEER")
				: msg.content.some((b) => b.type === "text" && b.text.includes("STEER"));
		});

		const base: Omit<AssistantMessage, "content" | "stopReason"> = {
			role: "assistant",
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
			timestamp: Date.now(),
		};

		const message: AssistantMessage =
			callCount === 1
				? {
						...base,
						content: [
							{
								type: "toolCall",
								id: "tc_echo_1",
								name: "echo",
								arguments: { text: "hi" },
							},
						],
						stopReason: "toolUse",
					}
				: {
						...base,
						content: [{ type: "text", text: hasSteer ? "steered" : "not-steered" }],
						stopReason: "stop",
					};

		queueMicrotask(() => {
			s.push({ type: "start", partial: message });
			s.push({
				type: "done",
				reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
				message,
			});
		});

		return s;
	};
}

class FakeTransport implements AgentTransport {
	private streamFn = makeFakeStreamFn();

	async *run(
		messages: Message[],
		userMessage: Message,
		cfg: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent> {
		const context: AgentContext = {
			systemPrompt: cfg.systemPrompt,
			messages,
			tools: cfg.tools,
		};

		const pc: AgentLoopConfig = {
			model: cfg.model,
			reasoning: cfg.reasoning,
			toolResultTransformer: cfg.toolResultTransformer,
			interrupt: cfg.interrupt,
		};

		for await (const ev of agentLoop(userMessage as unknown as UserMessage, context, pc, signal, this.streamFn)) {
			yield ev;
		}
	}
}

describe("steer injection", () => {
	it("injects queued message after tool results so the continuation reacts", async () => {
		const schema = Type.Object({ text: Type.String() });
		type EchoParams = Static<typeof schema>;

		const echoTool: AgentTool<typeof schema> = {
			label: "Echo",
			name: "echo",
			description: "Echo",
			parameters: schema,
			execute: async (_toolCallId: string, params: EchoParams) => {
				// Delay so we can enqueue while tools are running
				await delay(50);
				return { content: [{ type: "text", text: `echo:${params.text}` }], details: {} };
			},
		};

		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [echoTool],
			},
			queueMode: "one-at-a-time",
			transport: new FakeTransport(),
		});

		const p = agent.prompt("Initial");
		setTimeout(() => {
			agent.queueSteerMessage("STEER: do something else");
		}, 10);
		await p;

		const msgs = agent.state.messages;

		// The "steer" behavior we want is specifically:
		// after the toolResult(s), we inject the queued user message BEFORE the continuation assistant message.
		// So the conversation should NOT contain the intermediate "not-steered" assistant text.
		const hasNotSteered = msgs.some((m) => {
			if (m.role !== "assistant") return false;
			return (m as AssistantMessage).content.some((b) => b.type === "text" && b.text === "not-steered");
		});
		expect(hasNotSteered).toBe(false);

		const toolResultIndex = msgs.findIndex((m) => m.role === "toolResult");
		expect(toolResultIndex).toBeGreaterThanOrEqual(0);

		const injectedUser = msgs[toolResultIndex + 1];
		expect(injectedUser?.role).toBe("user");
		const injectedText =
			injectedUser && injectedUser.role === "user"
				? typeof injectedUser.content === "string"
					? injectedUser.content
					: injectedUser.content
							.filter((b) => b.type === "text")
							.map((b) => b.text)
							.join("\n")
				: "";
		expect(injectedText).toContain("STEER");

		const continuation = msgs[toolResultIndex + 2];
		expect(continuation?.role).toBe("assistant");
		const contText =
			continuation && continuation.role === "assistant"
				? (continuation as AssistantMessage).content.find((b) => b.type === "text")
				: undefined;
		expect(contText && contText.type === "text" ? contText.text : "").toBe("steered");
	});
});
