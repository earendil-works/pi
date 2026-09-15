import {
	type AgentRequestIdentity,
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>) {
		super(
			(candidate) => candidate.type === "done" || candidate.type === "error",
			(candidate) => {
				if (candidate.type === "done") return candidate.message;
				if (candidate.type === "error") return candidate.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => this.push(event));
	}
}

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "Mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("Agent request identity", () => {
	it("reuses identity for tool and steering continuations, then rotates for a follow-up", async () => {
		const identities: AgentRequestIdentity[] = [];
		let agent: Agent;
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "steer",
			label: "Steer",
			description: "Queues steering input",
			parameters: toolSchema,
			async execute() {
				agent.steer({ role: "user", content: "steering", timestamp: Date.now() });
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		let request = 0;
		agent = new Agent({
			sessionId: "pi-session",
			initialState: { model, tools: [tool] },
			streamFn: (_model, _context, options) => {
				identities.push(options?.requestIdentity as AgentRequestIdentity);
				if (request++ === 0) {
					const message = assistant([{ type: "toolCall", id: "tool-1", name: "steer", arguments: {} }], "toolUse");
					return new MockAssistantStream({ type: "done", reason: "toolUse", message });
				}
				if (request === 2) {
					agent.followUp({ role: "user", content: "follow up", timestamp: Date.now() });
				}
				const message = assistant([{ type: "text", text: "done" }]);
				return new MockAssistantStream({ type: "done", reason: "stop", message });
			},
		});

		await agent.prompt("start");

		expect(identities).toHaveLength(3);
		expect(identities[0]).toMatchObject({
			sessionId: "pi-session",
			threadId: "pi-session",
			requestKind: "turn",
			windowId: "pi-session:0",
		});
		expect(identities[1]).toEqual(identities[0]);
		expect(identities[2].turnId).not.toBe(identities[0].turnId);
	});

	it("preserves identity for retry continuation and rotates for the next prompt", async () => {
		const identities: AgentRequestIdentity[] = [];
		let request = 0;
		const agent = new Agent({
			sessionId: "pi-session",
			initialState: { model },
			streamFn: (_model, _context, options) => {
				identities.push(options?.requestIdentity as AgentRequestIdentity);
				if (request++ === 0) {
					const error = assistant([], "error", "retryable");
					return new MockAssistantStream({ type: "error", reason: "error", error });
				}
				const message = assistant([{ type: "text", text: "done" }]);
				return new MockAssistantStream({ type: "done", reason: "stop", message });
			},
		});

		await agent.prompt("first");
		agent.state.messages = agent.state.messages.slice(0, -1);
		await agent.continue();
		await agent.prompt("second");

		expect(identities[1]).toEqual(identities[0]);
		expect(identities[2].turnId).not.toBe(identities[0].turnId);
	});
});
