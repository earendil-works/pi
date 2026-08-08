import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

// Mirrors the mock infra in agent-loop.test.ts.
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

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeContext(): AgentContext {
	return { systemPrompt: "You are helpful.", messages: [], tools: [] };
}

describe("time-traveling stream rules", () => {
	it("aborts a matching stream, injects the reminder, and retries cleanly", async () => {
		let calls = 0;
		const llmMessagesSeen: Message[][] = [];
		const streamFn = (_model: Model<any>, llmContext: { messages: Message[] }, options: { signal?: AbortSignal }) => {
			const stream = new MockAssistantStream();
			calls++;
			llmMessagesSeen.push(llmContext.messages);
			queueMicrotask(() => {
				if (calls === 1) {
					stream.push({ type: "start", partial: createAssistantMessage([{ type: "text", text: "" }]) });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "Box::leak",
						partial: createAssistantMessage([{ type: "text", text: "I'll use Box::leak here" }]),
					});
					options.signal?.addEventListener("abort", () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantMessage([{ type: "text", text: "I'll use Box::leak here" }], "aborted"),
						});
					});
				} else {
					stream.push({ type: "start", partial: createAssistantMessage([{ type: "text", text: "" }]) });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "Use Arc<str>",
						partial: createAssistantMessage([{ type: "text", text: "Use Arc<str> instead." }]),
					});
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "Use Arc<str> instead." }]),
					});
				}
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamRules: [{ name: "box-leak", pattern: /Box::leak/, reminder: "Don't reach for Box::leak." }],
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("fix this")], makeContext(), config, undefined, streamFn);
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		// Rule fired exactly once, stream retried.
		const triggered = events.filter(
			(e): e is Extract<AgentEvent, { type: "stream_rule_triggered" }> => e.type === "stream_rule_triggered",
		);
		expect(triggered).toHaveLength(1);
		expect(triggered[0]).toMatchObject({ rule: "box-leak", attempt: 1 });
		expect(calls).toBe(2);

		// Final assistant message is the clean retry; the aborted partial is
		// not part of the emitted messages.
		expect(messages).toHaveLength(2);
		const final = messages[messages.length - 1];
		expect(final.role).toBe("assistant");
		expect((final as AssistantMessage).content).toEqual([{ type: "text", text: "Use Arc<str> instead." }]);

		// The retry saw a clean LLM context: both calls received only the user
		// message. If the aborted assistant partial had leaked into the context,
		// the second call would have seen ['user', 'assistant'].
		expect(llmMessagesSeen).toHaveLength(2);
		expect(llmMessagesSeen[0].map((m) => m.role)).toEqual(["user"]);
		expect(llmMessagesSeen[1].map((m) => m.role)).toEqual(["user"]);
	});

	it("passes through untouched when no rule matches", async () => {
		let calls = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			calls++;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage([{ type: "text", text: "" }]) });
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "plain answer",
					partial: createAssistantMessage([{ type: "text", text: "plain answer" }]),
				});
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "plain answer" }]),
				});
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamRules: [{ name: "nope", pattern: /forbidden-token/, reminder: "Never say forbidden-token." }],
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hi")], makeContext(), config, undefined, streamFn);
		for await (const event of stream) events.push(event);

		expect(events.some((e) => e.type === "stream_rule_triggered")).toBe(false);
		expect(calls).toBe(1);
	});

	it("stops retrying after streamRuleMaxRetries and finalizes the last response", async () => {
		let calls = 0;
		const streamFn = (_model: Model<any>, _context: unknown, options: { signal?: AbortSignal }) => {
			const stream = new MockAssistantStream();
			calls++;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage([{ type: "text", text: "" }]) });
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "Box::leak",
					partial: createAssistantMessage([{ type: "text", text: "still Box::leak" }]),
				});
				if (calls <= 2) {
					// First two attempts get aborted by the rule machinery.
					options.signal?.addEventListener("abort", () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantMessage([{ type: "text", text: "still Box::leak" }], "aborted"),
						});
					});
				} else {
					// Final attempt is left to finish and delivered as-is.
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "still Box::leak" }]),
					});
				}
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamRules: [{ name: "box-leak", pattern: /Box::leak/, reminder: "Don't use Box::leak." }],
			streamRuleMaxRetries: 2,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("fix this")], makeContext(), config, undefined, streamFn);
		for await (const event of stream) events.push(event);

		const triggered = events.filter(
			(e): e is Extract<AgentEvent, { type: "stream_rule_triggered" }> => e.type === "stream_rule_triggered",
		);
		// initial attempt + 2 retries = 3 calls, 2 triggers.
		expect(calls).toBe(3);
		expect(triggered.map((t) => t.attempt)).toEqual([1, 2]);

		// The final response is the last (still matching) response, delivered
		// as-is: the final attempt is not aborted (stop rather than aborted).
		const messages = await stream.result();
		const final = messages[messages.length - 1] as AssistantMessage;
		expect(final.stopReason).toBe("stop");
		expect((final.content as { type: "text"; text: string }[])[0].text).toBe("still Box::leak");
	});
});
