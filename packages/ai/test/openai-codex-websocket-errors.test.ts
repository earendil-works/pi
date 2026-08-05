import { afterEach, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const MODEL: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const CONTEXT: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
};

afterEach(() => {
	vi.unstubAllGlobals();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function successEvents(responseId: string, text?: string): Record<string, unknown>[] {
	const outputEvents = text
		? [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "message",
						id: `msg_${responseId}`,
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: `msg_${responseId}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text }],
					},
				},
			]
		: [];
	return [
		{ type: "response.created", response: { id: responseId } },
		...outputEvents,
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	];
}

function successfulSseResponse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_sse",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	].map((event) => `data: ${JSON.stringify(event)}`);
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`${events.join("\n\n")}\n\n`));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

interface MockWebSocketServer {
	connectionCount(): number;
	requests: Array<{ connectionId: number; body: Record<string, unknown> }>;
}

function stubWebSocketServer(
	getEvents: (connectionId: number, requestIndex: number) => Record<string, unknown>[],
): MockWebSocketServer {
	let connections = 0;
	const requests: MockWebSocketServer["requests"] = [];

	class MockWebSocket extends EventTarget {
		static OPEN = 1;
		static CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		private readonly connectionId = ++connections;

		constructor() {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}

		send(data: string): void {
			requests.push({ connectionId: this.connectionId, body: JSON.parse(data) as Record<string, unknown> });
			const events = getEvents(this.connectionId, requests.length);
			queueMicrotask(() => {
				for (const event of events) {
					this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
				}
			});
		}

		close(): void {
			this.readyState = MockWebSocket.CLOSED;
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	return { connectionCount: () => connections, requests };
}

function transientFailure(type: "response.failed" | "error" = "response.failed"): Record<string, unknown> {
	const error = {
		code: "account_temporarily_unavailable",
		message: "This account is temporarily unavailable",
	};
	return type === "response.failed" ? { type, response: { error } } : { type, error };
}

it.each(["response.failed", "error"] as const)(
	"retries an unknown %s once by default before assistant content",
	async (failureType) => {
		vi.useFakeTimers();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const server = stubWebSocketServer((connectionId) =>
			connectionId === 1
				? [
						{ type: "response.created", response: { id: "failed_response" } },
						{ type: "codex.rate_limits", rate_limits: {} },
						transientFailure(failureType),
					]
				: successEvents("recovered_response"),
		);
		const responseStream = streamOpenAICodexResponses(MODEL, CONTEXT, {
			apiKey: mockToken(),
			transport: "auto",
		});
		const eventTypes: string[] = [];
		const resultPromise = (async () => {
			for await (const event of responseStream) eventTypes.push(event.type);
			return responseStream.result();
		})();

		await vi.advanceTimersByTimeAsync(0);
		expect(server.connectionCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		const result = await resultPromise;

		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("recovered_response");
		expect(server.connectionCount()).toBe(2);
		expect(server.requests[1].body).toEqual(server.requests[0].body);
		expect(eventTypes.filter((type) => type === "start")).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	},
);

it("falls back to SSE after the default websocket retry and keeps fallback sticky", async () => {
	vi.useFakeTimers();
	const fetchMock = vi.fn(async () => successfulSseResponse());
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer(() => [
		{ type: "response.created", response: { id: "failed_response" } },
		transientFailure(),
	]);
	const options = { apiKey: mockToken(), sessionId: "sticky-fallback", transport: "websocket" as const };

	const firstPromise = streamOpenAICodexResponses(MODEL, CONTEXT, options).result();
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(1000);
	const first = await firstPromise;

	expect(first.stopReason).toBe("stop");
	expect(first.responseId).toBeUndefined();
	expect(server.connectionCount()).toBe(2);
	expect(fetchMock).toHaveBeenCalledTimes(1);

	const second = await streamOpenAICodexResponses(MODEL, CONTEXT, options).result();
	expect(second.stopReason).toBe("stop");
	expect(server.connectionCount()).toBe(2);
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("respects explicit maxRetries zero", async () => {
	const fetchMock = vi.fn(async () => successfulSseResponse());
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer(() => [transientFailure()]);

	const result = await streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		transport: "auto",
		maxRetries: 0,
	}).result();

	expect(result.stopReason).toBe("stop");
	expect(server.connectionCount()).toBe(1);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("honors a larger configured websocket retry budget before falling back", async () => {
	vi.useFakeTimers();
	const fetchMock = vi.fn(async () => successfulSseResponse());
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer(() => [transientFailure()]);

	const resultPromise = streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		transport: "auto",
		maxRetries: 2,
	}).result();
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(1000);
	await vi.advanceTimersByTimeAsync(2000);
	const result = await resultPromise;

	expect(result.stopReason).toBe("stop");
	expect(server.connectionCount()).toBe(3);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

const TERMINAL_CODES = [
	"authentication_error",
	"bio_policy",
	"context_length_exceeded",
	"cyber_policy",
	"insufficient_quota",
	"invalid_prompt",
	"invalid_request_error",
	"permission_error",
	"server_is_overloaded",
	"slow_down",
	"usage_limit_reached",
	"usage_not_included",
];

it.each([
	...TERMINAL_CODES.map((code) => [code, { code, message: "Terminal" }]),
	...["authentication_error", "invalid_request_error", "permission_error", "usage_limit_reached"].map((type) => [
		`error.type ${type}`,
		{ type, message: "Terminal" },
	]),
] as Array<[string, Record<string, unknown>]>)("does not retry terminal stream failure %s", async (_name, error) => {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer(() => [{ type: "response.failed", response: { error } }]);

	const result = await streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		transport: "auto",
		maxRetries: 3,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(server.connectionCount()).toBe(1);
	expect(fetchMock).not.toHaveBeenCalled();
});

it("prefers a specific unknown code over a generic terminal error type", async () => {
	vi.useFakeTimers();
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer((connectionId) =>
		connectionId === 1
			? [
					{
						type: "response.failed",
						response: {
							error: {
								code: "account_temporarily_unavailable",
								type: "invalid_request_error",
								message: "This account is temporarily unavailable",
							},
						},
					},
				]
			: successEvents("recovered_response"),
	);

	const resultPromise = streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		transport: "auto",
	}).result();
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(1000);
	const result = await resultPromise;

	expect(result.stopReason).toBe("stop");
	expect(server.connectionCount()).toBe(2);
	expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps connection-limit recovery outside the general retry budget", async () => {
	const fetchMock = vi.fn(async () => successfulSseResponse());
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer(() => [{ type: "error", error: { code: "websocket_connection_limit_reached" } }]);

	const result = await streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		transport: "auto",
		maxRetries: 3,
	}).result();

	expect(result.stopReason).toBe("stop");
	expect(server.connectionCount()).toBe(2);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps missing-continuation recovery outside the general retry budget", async () => {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer(() => [
		{ type: "error", error: { code: "previous_response_not_found", message: "Previous response not found" } },
	]);

	const result = await streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		transport: "auto",
		maxRetries: 3,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(server.connectionCount()).toBe(2);
	expect(fetchMock).not.toHaveBeenCalled();
});

it("retries cached websocket failures with full history", async () => {
	vi.useFakeTimers();
	const server = stubWebSocketServer((_connectionId, requestIndex) => {
		if (requestIndex === 1) return successEvents("resp_1", "Hello");
		if (requestIndex === 2) return [{ type: "codex.rate_limits", rate_limits: {} }, transientFailure()];
		return successEvents("resp_2");
	});

	const first = await streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		sessionId: "cached-retry",
		transport: "websocket-cached",
	}).result();
	const secondContext: Context = {
		...CONTEXT,
		messages: [...CONTEXT.messages, first, { role: "user", content: "Continue", timestamp: 2 }],
	};
	const resultPromise = streamOpenAICodexResponses(MODEL, secondContext, {
		apiKey: mockToken(),
		sessionId: "cached-retry",
		transport: "websocket-cached",
	}).result();

	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(1000);
	const result = await resultPromise;

	expect(result.stopReason).toBe("stop");
	expect(server.requests).toHaveLength(3);
	expect(server.requests[1].body.previous_response_id).toBe("resp_1");
	expect(server.requests[1].body.input).toHaveLength(1);
	expect(server.requests[2].body.previous_response_id).toBeUndefined();
	expect(server.requests[2].body.input).toHaveLength(3);
});

it("does not retry after assistant content has started", async () => {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	const server = stubWebSocketServer(() => [
		{ type: "response.created", response: { id: "resp_1" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		transientFailure(),
	]);

	const result = await streamOpenAICodexResponses(MODEL, CONTEXT, {
		apiKey: mockToken(),
		transport: "auto",
		maxRetries: 2,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(server.connectionCount()).toBe(1);
	expect(fetchMock).not.toHaveBeenCalled();
});
