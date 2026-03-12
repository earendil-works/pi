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
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseResponse(sse: string): Response {
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

describe("openai-codex retry", () => {
	it("retries streamed server_error frames before any content by default", async () => {
		const streamedErrorSse = `data: ${JSON.stringify({
			type: "error",
			error: {
				type: "server_error",
				code: "server_error",
				message: "An error occurred while processing your request.",
			},
		})}\n\n`;

		const successSse =
			[
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				})}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				})}`,
				`data: ${JSON.stringify({
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n") + "\n\n";

		let callCount = 0;
		global.fetch = vi.fn(async () => {
			callCount += 1;
			if (callCount <= 5) {
				return createSseResponse(streamedErrorSse);
			}
			return createSseResponse(successSse);
		}) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: { baseDelay: 0, maxDelay: 0 },
		});

		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(callCount).toBe(6);
		expect(result.stopReason).toBe("stop");
	});

	it("retries when the SSE stream emits an upstream buffer-limit error", async () => {
		const upstreamErrorSse = `data: ${JSON.stringify({
			type: "error",
			code: "bad_gateway",
			message: "exceeded request buffer limit while retrying upstream",
		})}\n\n`;

		const successSse =
			[
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				})}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				})}`,
				`data: ${JSON.stringify({
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n") + "\n\n";

		let callCount = 0;
		const fetchMock = vi.fn(async () => {
			callCount += 1;
			if (callCount === 1) {
				return createSseResponse(upstreamErrorSse);
			}
			return createSseResponse(successSse);
		});
		global.fetch = fetchMock as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			codexRetry: {
				requestMaxRetries: 0,
				streamMaxRetries: 1,
				baseDelay: 0,
				maxDelay: 0,
			},
		});

		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
	});
});
