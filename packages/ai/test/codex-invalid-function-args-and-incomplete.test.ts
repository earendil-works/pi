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

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Run check", timestamp: Date.now() }],
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

describe("openai-codex malformed args + incomplete handling", () => {
	it("does not crash when function_call arguments are malformed text", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "exec_command",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					delta: "to=functions.exec_command commentary json",
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "exec_command",
						arguments: "",
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

		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes).toContain("done");
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
	});

	it("surfaces response.incomplete reason instead of generic stream terminated", async () => {
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
				{ type: "response.output_text.delta", delta: "partial" },
				{
					type: "response.incomplete",
					response: {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
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
			eventTypes.push(event.type === "error" ? `error:${event.reason}` : event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toContain("error:error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage?.toLowerCase()).toContain("incomplete");
		expect(result.errorMessage).toContain("max_output_tokens");
	});

	it("ignores orphan tool argument deltas when no tool call item was started", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{ type: "response.function_call_arguments.delta", delta: '{"cmd":"echo hello"}' },
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
			eventTypes.push(event.type === "error" ? `error:${event.reason}` : event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toContain("done");
		expect(eventTypes).not.toContain("error:error");
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});
});
