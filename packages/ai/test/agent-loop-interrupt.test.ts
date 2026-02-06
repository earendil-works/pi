import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent/agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentTool } from "../src/agent/types.js";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, UserMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function makeModel(): Model<"google-generative-ai"> {
	return {
		id: "fake-model",
		name: "Fake Model",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function makeAssistantMessageBase(model: Model<any>): Omit<AssistantMessage, "content" | "stopReason"> {
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
	const model = makeModel();
	let callCount = 0;

	return (_m: Model<any>, context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream => {
		callCount++;
		const stream = new AssistantMessageEventStream();

		const hasSteer = context.messages.some((msg) => {
			if (msg.role !== "user") return false;
			return typeof msg.content === "string"
				? msg.content.includes("STEER")
				: msg.content.some((b) => b.type === "text" && b.text.includes("STEER"));
		});

		const message: AssistantMessage =
			callCount === 1
				? {
						...makeAssistantMessageBase(model),
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
						...makeAssistantMessageBase(model),
						content: [{ type: "text", text: hasSteer ? "steered" : "not-steered" }],
						stopReason: "stop",
					};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({
				type: "done",
				reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
				message,
			});
		});

		return stream;
	};
}

describe("agentLoop interrupt", () => {
	it("injects a user message after tool results and before continuation LLM call", async () => {
		const model = makeModel();
		const echoSchema = Type.Object({ text: Type.String() });
		type EchoParams = Static<typeof echoSchema>;

		const tool: AgentTool<typeof echoSchema, { echoed: string }> = {
			label: "Echo",
			name: "echo",
			description: "echo",
			parameters: echoSchema,
			execute: async (_id: string, params: EchoParams) => {
				return {
					content: [{ type: "text", text: `echo:${params.text}` }],
					details: { echoed: params.text },
				};
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

		const events: Array<{ type: string; role?: string; text?: string }> = [];
		const streamFn = makeFakeStreamFn();

		const cfg: AgentLoopConfig = {
			model,
			interrupt: async ({ toolResults }) => {
				// Must be called after tools executed
				expect(toolResults).toHaveLength(1);
				return [{ role: "user", content: "STEER", timestamp: Date.now() }];
			},
		};

		const s = agentLoop(prompt, context, cfg, undefined, streamFn);
		for await (const ev of s) {
			if (ev.type === "message_start" || ev.type === "message_end") {
				const msg = ev.message as Message;
				if (msg.role === "user") {
					const text =
						typeof msg.content === "string"
							? msg.content
							: msg.content[0]?.type === "text"
								? msg.content[0].text
								: "";
					events.push({ type: ev.type, role: msg.role, text });
				}
			}
		}

		const result = await s.result();
		const roles = result.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);

		// The injected user message should be present and the continuation should be steered.
		const injectedUser = result.find(
			(m) => m.role === "user" && (typeof m.content === "string" ? m.content === "STEER" : false),
		);
		expect(injectedUser).toBeTruthy();

		const lastAssistant = result[result.length - 1] as AssistantMessage;
		const lastText = lastAssistant.content.find((b) => b.type === "text");
		expect(lastText && lastText.type === "text" ? lastText.text : "").toBe("steered");

		// Also ensure message_start/end were emitted for the injected user message.
		const userTexts = events.filter((e) => e.role === "user").map((e) => `${e.type}:${e.text}`);
		expect(userTexts).toContain("message_start:Initial");
		expect(userTexts).toContain("message_end:Initial");
		expect(userTexts).toContain("message_start:STEER");
		expect(userTexts).toContain("message_end:STEER");
	});
});
