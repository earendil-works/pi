/**
 * Tests for maxParallelTools concurrency limiting.
 *
 * Verifies that executeToolCallsParallel never exceeds the configured
 * concurrency limit even when many tools are dispatched at once.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

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
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
}

function makeTool(name: string, onExecute: () => Promise<void>): AgentTool {
	return {
		name,
		description: `Tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => {
			await onExecute();
			return { content: [{ type: "text", text: `${name} done` }], details: {} };
		},
	};
}

describe("maxParallelTools", () => {
	it("respects concurrency limit — never exceeds maxParallelTools active at once", async () => {
		const TOOL_COUNT = 8;
		const MAX_PARALLEL = 3;

		let active = 0;
		let peakActive = 0;

		// Each tool takes 20 ms to simulate real async work.
		const tools: AgentTool[] = Array.from({ length: TOOL_COUNT }, (_, i) =>
			makeTool(`tool_${i}`, async () => {
				active++;
				if (active > peakActive) peakActive = active;
				await new Promise((r) => setTimeout(r, 20));
				active--;
			}),
		);

		// Build a single assistant message that calls all tools at once.
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: tools.map((t) => ({
				type: "toolCall" as const,
				id: `call_${t.name}`,
				name: t.name,
				arguments: {},
			})),
			stopReason: "tool_use",
			usage: createUsage(),
		};

		let turnCount = 0;
		const streamFn = (_model: Model, _ctx: unknown, _opts: unknown) => {
			const stream = new MockAssistantStream();
			turnCount++;
			if (turnCount === 1) {
				// First turn: return the tool-calling message.
				setTimeout(() => {
					stream.push({ type: "done", message: assistantMsg });
				}, 0);
			} else {
				// Second turn: stop the loop.
				const stopMsg: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					usage: createUsage(),
				};
				setTimeout(() => {
					stream.push({ type: "done", message: stopMsg });
				}, 0);
			}
			return Promise.resolve(stream);
		};

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "run all tools" }] } as UserMessage],
			tools,
		};

		const config: AgentLoopConfig = {
			model: { provider: "anthropic", name: "claude-3-haiku-20240307" } as Model,
			maxTokens: 1024,
			toolExecution: "parallel",
			maxParallelTools: MAX_PARALLEL,
			convertToLlm: async (msgs: AgentMessage[]) => msgs as unknown as Message[],
		};

		const stream = agentLoop(context.messages, context, config, undefined, streamFn as any);
		for await (const _ of stream) { /* consume */ }

		expect(peakActive).toBeLessThanOrEqual(MAX_PARALLEL);
		// All tools must have finished.
		expect(active).toBe(0);
	});

	it("defaults to 5 when maxParallelTools is not set", async () => {
		const TOOL_COUNT = 10;
		let peakActive = 0;
		let active = 0;

		const tools: AgentTool[] = Array.from({ length: TOOL_COUNT }, (_, i) =>
			makeTool(`tool_${i}`, async () => {
				active++;
				if (active > peakActive) peakActive = active;
				await new Promise((r) => setTimeout(r, 20));
				active--;
			}),
		);

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: tools.map((t) => ({
				type: "toolCall" as const,
				id: `call_${t.name}`,
				name: t.name,
				arguments: {},
			})),
			stopReason: "tool_use",
			usage: createUsage(),
		};

		let turnCount = 0;
		const streamFn = (_model: Model, _ctx: unknown, _opts: unknown) => {
			const stream = new MockAssistantStream();
			turnCount++;
			if (turnCount === 1) {
				setTimeout(() => stream.push({ type: "done", message: assistantMsg }), 0);
			} else {
				const stop: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					usage: createUsage(),
				};
				setTimeout(() => stream.push({ type: "done", message: stop }), 0);
			}
			return Promise.resolve(stream);
		};

		const context: AgentContext = {
			systemPrompt: "test",
			messages: [{ role: "user", content: [{ type: "text", text: "go" }] } as UserMessage],
			tools,
		};

		const config: AgentLoopConfig = {
			model: { provider: "anthropic", name: "claude-3-haiku-20240307" } as Model,
			maxTokens: 1024,
			toolExecution: "parallel",
			// maxParallelTools intentionally omitted → should default to 5
			convertToLlm: async (msgs: AgentMessage[]) => msgs as unknown as Message[],
		};

		const stream = agentLoop(context.messages, context, config, undefined, streamFn as any);
		for await (const _ of stream) { /* consume */ }

		// Default limit is 5.
		expect(peakActive).toBeLessThanOrEqual(5);
		expect(active).toBe(0);
	});
});
