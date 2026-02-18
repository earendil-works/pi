// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function createCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

function createContext(
	toolsOverride?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): Context {
	return {
		messages: [{ role: "user", content: "Run a command", timestamp: Date.now() }],
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

function createSseResponse(events: Array<Record<string, unknown>>): Response {
	const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("openai-codex non-function tool call parsing", () => {
	it("parses custom_tool_call into a toolCall block", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_1",
						call_id: "call_custom_1",
						name: "functions.exec_command",
						input: '{"cmd":"pwd"}',
						status: "in_progress",
					},
				},
				{
					type: "response.custom_tool_call_input.done",
					input: '{"cmd":"pwd"}',
				},
				{
					type: "response.output_item.done",
					item: {
						type: "custom_tool_call",
						id: "ct_1",
						call_id: "call_custom_1",
						name: "functions.exec_command",
						input: '{"cmd":"pwd"}',
						status: "completed",
					},
				},
				{
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call.name).toBe("exec_command");
		expect(call.arguments).toEqual({ cmd: "pwd" });
	});

	it("parses custom_tool_call when input includes assistant-prefix noise", async () => {
		const noisyInput = 'I’ll summarize results. ♀assistant to=functions.exec_command commentary json {"cmd":"pwd"}';

		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_noise_1",
						call_id: "call_custom_noise_1",
						name: "functions.exec_command",
						input: noisyInput,
						status: "in_progress",
					},
				},
				{
					type: "response.custom_tool_call_input.done",
					input: noisyInput,
				},
				{
					type: "response.output_item.done",
					item: {
						type: "custom_tool_call",
						id: "ct_noise_1",
						call_id: "call_custom_noise_1",
						name: "functions.exec_command",
						input: noisyInput,
						status: "completed",
					},
				},
				{
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call.name).toBe("exec_command");
		expect(call.arguments).toEqual({ cmd: "pwd" });
	});

	it("normalizes legacy function-style tool names to available tools", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
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
					type: "response.custom_tool_call_input.done",
					input: '{"command":"pwd"}',
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
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(
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
			{
				apiKey: createCodexToken(),
				codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
			},
		);

		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call.name).toBe("bash");
		expect(call.arguments).toEqual({ command: "pwd" });
	});

	it("parses local_shell_call into exec_command-style toolCall", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
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
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call.name).toBe("exec_command");
		expect(call.arguments).toEqual({ cmd: "pwd" });
	});

	it("upserts a function_call toolCall when output_item.added is missing", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
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
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call.name).toBe("exec_command");
		expect(call.arguments).toEqual({ cmd: "pwd" });
	});

	it("recovers leaked assistant-to-functions text into a toolCall", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.output_item.added",
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "in_progress",
						content: [{ type: "output_text", text: "" }],
					},
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
								text: 'Running now. assistant to=functions.exec_command commentary json {"cmd":"bun run typecheck"}',
							},
						],
					},
				},
				{
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call.name).toBe("exec_command");
		expect(call.arguments).toEqual({ cmd: "bun run typecheck" });
	});

	it("recovers leaked tool call when message exists only in output_item.done", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
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
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.content.some((block) => block.type === "text")).toBe(true);
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call.name).toBe("exec_command");
		expect(call.arguments).toEqual({ cmd: "pwd" });
	});

	it("does not recover leaked tool call when tool is unavailable", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
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
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		) as typeof fetch;

		const stream = streamOpenAICodexResponses(
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
			{
				apiKey: createCodexToken(),
				codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
			},
		);
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
	});
});
