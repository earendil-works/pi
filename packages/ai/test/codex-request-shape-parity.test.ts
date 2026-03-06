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
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
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

describe("openai-codex request shape parity", () => {
	it("sends Codex-parity auth/session headers and request body keys", async () => {
		let capturedInit: RequestInit | undefined;

		global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			capturedInit = init;
			return createSseResponse([
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
			]);
		}) as typeof fetch;

		const sessionId = "thread_123";
		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			sessionId,
			parallelToolCalls: true,
			reasoningEffort: "medium",
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		expect(capturedInit).toBeDefined();
		const headers = new Headers(capturedInit?.headers as HeadersInit);
		expect(headers.get("authorization")).toBe(`Bearer ${createCodexToken()}`);
		expect(headers.get("chatgpt-account-id")).toBe("acc_test");
		expect(headers.get("session_id")).toBe(sessionId);
		expect(headers.get("openai-organization")).toBeNull();
		expect(headers.get("openai-conversation-id")).toBeNull();
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("content-type")).toBe("application/json");

		const body = JSON.parse(String(capturedInit?.body ?? "{}")) as Record<string, unknown>;
		expect(body.stream).toBe(true);
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(true);
		expect(body.prompt_cache_key).toBe(sessionId);
	});

	it("sends service_tier=priority when fast mode is enabled", async () => {
		let capturedFastInit: RequestInit | undefined;

		global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			capturedFastInit = init;
			return createSseResponse([
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
			]);
		}) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: createCodexToken(),
			fastMode: true,
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		const body = JSON.parse(String(capturedFastInit?.body ?? "{}")) as Record<string, unknown>;
		expect(body.service_tier).toBe("priority");
	});
});
