// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

let nextStreamEvents: unknown[] = [];

vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (_params: unknown) => {
					async function* gen(): AsyncGenerator<unknown> {
						for (const ev of nextStreamEvents) yield ev;
					}
					return gen();
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

afterEach(() => {
	nextStreamEvents = [];
	vi.restoreAllMocks();
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createContext(
	toolsOverride?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): Context {
	return {
		messages: [{ role: "user", content: "Call tool", timestamp: Date.now() }],
		tools: toolsOverride ?? [
			{
				name: "exec_command",
				description: "Run a shell command",
				parameters: {
					type: "object",
					properties: { cmd: { type: "string" } },
					required: ["cmd"],
				},
			},
		],
	};
}

describe("openai-responses non-function tool call parsing", () => {
	it("parses custom_tool_call with noisy envelope text into toolCall", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: {
					type: "custom_tool_call",
					id: "ct_1",
					call_id: "call_custom_1",
					name: "functions.exec_command",
					input: 'I’ll summarize all results.numerusformassistant to=functions.exec_command մեկնաբանություն json {"cmd":"pwd"}',
					status: "in_progress",
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					id: "ct_1",
					call_id: "call_custom_1",
					name: "functions.exec_command",
					input: 'I’ll summarize all results.numerusformassistant to=functions.exec_command մեկնաբանություն json {"cmd":"pwd"}',
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const eventTypes: string[] = [];
		for await (const ev of stream) {
			eventTypes.push(ev.type);
		}
		const message = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(message.stopReason).toBe("toolUse");

		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("exec_command");
			expect(toolCall.arguments).toEqual({ cmd: "pwd" });
		}
	});

	it("normalizes legacy function-style tool names to available tools", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: {
					type: "custom_tool_call",
					id: "ct_legacy_name",
					call_id: "call_legacy_name",
					name: "functions.Bash",
					input: '{"command":"pwd"}',
					status: "in_progress",
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					id: "ct_legacy_name",
					call_id: "call_legacy_name",
					name: "functions.Bash",
					input: '{"command":"pwd"}',
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(
			createModel(),
			createContext([
				{
					name: "bash",
					description: "Execute a shell command",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			]),
			{ apiKey: "test-key" },
		);
		for await (const _ev of stream) {
			// drain
		}
		const message = await stream.result();

		expect(message.stopReason).toBe("toolUse");
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("bash");
			expect(toolCall.arguments).toEqual({ command: "pwd" });
		}
	});

	it("parses local_shell_call into exec_command-style toolCall", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: {
					type: "local_shell_call",
					id: "ls_1",
					call_id: "call_shell_1",
					action: { type: "exec", command: ["pwd"] },
					status: "in_progress",
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "local_shell_call",
					id: "ls_1",
					call_id: "call_shell_1",
					action: { type: "exec", command: ["pwd"] },
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const eventTypes: string[] = [];
		for await (const ev of stream) {
			eventTypes.push(ev.type);
		}
		const message = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(message.stopReason).toBe("toolUse");

		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("exec_command");
			expect(toolCall.arguments).toEqual({ cmd: "pwd" });
		}
	});

	it("upserts a function_call toolCall when output_item.added is missing", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_done_only",
					call_id: "call_done_only",
					name: "exec_command",
					arguments: '{"cmd":"pwd"}',
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const eventTypes: string[] = [];
		for await (const ev of stream) {
			eventTypes.push(ev.type);
		}
		const message = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(message.stopReason).toBe("toolUse");
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("exec_command");
			expect(toolCall.arguments).toEqual({ cmd: "pwd" });
		}
	});

	it("recovers leaked assistant-to-functions text into a toolCall", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: 'I’m running it now. assistant to=functions.exec_command commentary json {"cmd":"bun run typecheck"}',
						},
					],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const eventTypes: string[] = [];
		for await (const ev of stream) {
			eventTypes.push(ev.type);
		}
		const message = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(message.stopReason).toBe("toolUse");
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("exec_command");
			expect(toolCall.arguments).toEqual({ cmd: "bun run typecheck" });
		}
	});

	it("recovers leaked tool call when message exists only in output_item.done", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_done_only",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: 'Running now. assistant to=functions.exec_command commentary json {"cmd":"pwd"}',
						},
					],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		for await (const _ev of stream) {
			// drain
		}
		const message = await stream.result();

		expect(message.content.some((block) => block.type === "text")).toBe(true);
		expect(message.stopReason).toBe("toolUse");
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("exec_command");
			expect(toolCall.arguments).toEqual({ cmd: "pwd" });
		}
	});

	it("does not recover leaked tool call when tool is unavailable", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_unavailable_tool",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: 'Running now. assistant to=functions.exec_command commentary json {"cmd":"pwd"}',
						},
					],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(
			createModel(),
			createContext([
				{
					name: "bash",
					description: "Execute a shell command",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			]),
			{ apiKey: "test-key" },
		);
		for await (const _ev of stream) {
			// drain
		}
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		expect(message.content.some((block) => block.type === "toolCall")).toBe(false);
	});
});
