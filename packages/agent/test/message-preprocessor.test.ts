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
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.js";

import { Agent } from "../src/agent.js";
import type { AgentRunConfig, AgentTransport } from "../src/transports/types.js";

function makeAssistantBase(model: Model<any>): Omit<AssistantMessage, "content" | "stopReason"> {
	return {
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
}

function makeFakeStreamFn() {
	const model = getModel("google", "gemini-2.5-flash");
	let callCount = 0;

	return (_m: Model<any>, _ctx: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream => {
		callCount++;
		const s = new AssistantMessageEventStream();

		const msg: AssistantMessage =
			callCount === 1
				? {
						...makeAssistantBase(model),
						content: [{ type: "toolCall", id: "tc1", name: "echo", arguments: { text: "hi" } }],
						stopReason: "toolUse",
					}
				: {
						...makeAssistantBase(model),
						content: [{ type: "text", text: "done" }],
						stopReason: "stop",
					};

		queueMicrotask(() => {
			s.push({ type: "start", partial: msg });
			s.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg });
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
			preprocessor: cfg.preprocessor,
			toolResultTransformer: cfg.toolResultTransformer,
			interrupt: cfg.interrupt,
		};

		for await (const ev of agentLoop(userMessage as unknown as UserMessage, context, pc, signal, this.streamFn)) {
			yield ev;
		}
	}
}

describe("Agent messagePreprocessor", () => {
	it("is invoked before each LLM call within a multi-turn run", async () => {
		let calls = 0;

		const schema = Type.Object({ text: Type.String() });
		const echoTool: AgentTool<typeof schema, unknown> = {
			label: "Echo",
			name: "echo",
			description: "Echo",
			parameters: schema,
			execute: async (_id, _params) => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};

		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-2.5-flash"),
				thinkingLevel: "off",
				tools: [echoTool],
			},
			transport: new FakeTransport(),
			messagePreprocessor: async (messages) => {
				calls++;
				return messages;
			},
		});

		await agent.prompt("hi");
		expect(calls).toBe(2);
	});
});
