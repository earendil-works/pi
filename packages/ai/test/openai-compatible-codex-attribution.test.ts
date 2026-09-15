import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AgentRequestIdentity, Context, Model } from "../src/types.ts";

const identity: AgentRequestIdentity = {
	sessionId: "session-1",
	threadId: "thread-1",
	turnId: "turn-1",
	requestKind: "turn",
	startedAt: 123456789,
	windowId: "thread-1:0",
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function createModel<TApi extends "openai-completions" | "openai-responses">(
	api: TApi,
	codexAttribution?: "official",
): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-proxy",
		baseUrl: "https://proxy.example.com/v1",
		compat: codexAttribution ? ({ codexAttribution } as Model<TApi>["compat"]) : undefined,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function chatCompletionSse(): string {
	return 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
}

function responsesSse(): string {
	return 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}\n\n';
}

describe("OpenAI-compatible Codex attribution", () => {
	it("emits official headers for opted-in Chat Completions proxies", async () => {
		let headers: Headers | undefined;
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				headers = new Headers(init?.headers);
				body = JSON.parse(String(init?.body));
				return new Response(chatCompletionSse(), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		await streamOpenAICompletions(createModel("openai-completions", "official"), context, {
			apiKey: "test-key",
			requestIdentity: identity,
		}).result();

		expect(headers?.get("originator")).toBe("pi");
		expect(headers?.get("session-id")).toBe(identity.sessionId);
		expect(headers?.get("thread-id")).toBe(identity.threadId);
		expect(headers?.get("x-client-request-id")).toBe(identity.threadId);
		expect(headers?.get("x-codex-window-id")).toBe(identity.windowId);
		expect(JSON.parse(headers?.get("x-codex-turn-metadata") ?? "{}")).toMatchObject({
			turn_id: identity.turnId,
			request_kind: identity.requestKind,
		});
		expect(body?.client_metadata).toBeUndefined();
	});

	it("emits headers and client_metadata for opted-in Responses proxies", async () => {
		let headers: Headers | undefined;
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				headers = new Headers(init?.headers);
				body = JSON.parse(String(init?.body));
				return new Response(responsesSse(), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		await streamOpenAIResponses(createModel("openai-responses", "official"), context, {
			apiKey: "test-key",
			requestIdentity: identity,
		}).result();

		expect(headers?.get("originator")).toBe("pi");
		expect(headers?.get("thread-id")).toBe(identity.threadId);
		const clientMetadata = body?.client_metadata as Record<string, string>;
		expect(clientMetadata).toMatchObject({
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
			"x-codex-window-id": identity.windowId,
		});
		expect(headers?.get("x-codex-turn-metadata")).toBe(clientMetadata["x-codex-turn-metadata"]);
	});

	it("does not emit Codex metadata without the compatibility opt-in", async () => {
		let headers: Headers | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				headers = new Headers(init?.headers);
				return new Response(chatCompletionSse(), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		await streamOpenAICompletions(createModel("openai-completions"), context, {
			apiKey: "test-key",
			requestIdentity: identity,
		}).result();

		expect(headers?.get("originator")).toBeNull();
		expect(headers?.get("x-codex-turn-metadata")).toBeNull();
	});
});
