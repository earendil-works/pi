import { afterEach, describe, expect, it, vi } from "vitest";
import {
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import type { AgentRequestIdentity, Context, Model } from "../src/types.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const model: Model<"openai-codex-responses"> = {
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

const context: Context = {
	systemPrompt: "You are helpful.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

const identity: AgentRequestIdentity = {
	sessionId: "session-1",
	threadId: "thread-1",
	turnId: "turn-1",
	requestKind: "turn",
	startedAt: 123456789,
	installationId: "installation-é",
	windowId: "thread-1:0",
};

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

function completedEvents(): Array<Record<string, unknown>> {
	return [
		{
			type: "response.completed",
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
	];
}

function parseTurnMetadata(clientMetadata: Record<string, string>): Record<string, unknown> {
	return JSON.parse(clientMetadata["x-codex-turn-metadata"]);
}

describe("OpenAI Codex attribution", () => {
	it("sends canonical identity in SSE headers and client_metadata independently of caching", async () => {
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		const sse = `${completedEvents()
			.map((event) => `data: ${JSON.stringify(event)}`)
			.join("\n\n")}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers as Headers;
				capturedBody = JSON.parse(String(init?.body));
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token(),
			transport: "sse",
			cacheRetention: "none",
			sessionId: "cache-session",
			requestIdentity: identity,
		}).result();

		expect(capturedHeaders?.get("originator")).toBe("pi");
		expect(capturedHeaders?.get("session-id")).toBe(identity.sessionId);
		expect(capturedHeaders?.get("thread-id")).toBe(identity.threadId);
		expect(capturedHeaders?.get("x-client-request-id")).toBe(identity.threadId);
		expect(capturedHeaders?.get("x-codex-window-id")).toBe(identity.windowId);
		expect(capturedHeaders?.get("x-codex-installation-id")).toBe(identity.installationId);
		expect(capturedBody?.prompt_cache_key).toBeUndefined();

		const clientMetadata = capturedBody?.client_metadata as Record<string, string>;
		expect(clientMetadata).toMatchObject({
			"x-codex-installation-id": identity.installationId,
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
			"x-codex-window-id": identity.windowId,
		});
		expect(parseTurnMetadata(clientMetadata)).toEqual({
			installation_id: identity.installationId,
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
			window_id: identity.windowId,
			request_kind: "turn",
			turn_started_at_unix_ms: identity.startedAt,
		});
		expect([...clientMetadata["x-codex-turn-metadata"]].every((character) => character.charCodeAt(0) < 128)).toBe(
			true,
		);
		expect(capturedHeaders?.get("x-codex-turn-metadata")).toBe(clientMetadata["x-codex-turn-metadata"]);
	});

	it("puts current-turn client_metadata on each WebSocket response.create frame", async () => {
		let handshakeHeaders: Record<string, string> | undefined;
		let sentBody: Record<string, unknown> | undefined;
		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, options?: { headers?: Record<string, string> }) {
				handshakeHeaders = options?.headers;
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.listeners.get(type) ?? new Set();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBody = JSON.parse(data);
				queueMicrotask(() => {
					for (const event of completedEvents()) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		await streamOpenAICodexResponses(model, context, {
			apiKey: token(),
			transport: "websocket",
			requestIdentity: identity,
		}).result();

		expect(handshakeHeaders?.["session-id"]).toBe(identity.sessionId);
		expect(handshakeHeaders?.["thread-id"]).toBe(identity.threadId);
		expect(handshakeHeaders?.["x-client-request-id"]).toBe(identity.threadId);
		const clientMetadata = sentBody?.client_metadata as Record<string, string>;
		expect(clientMetadata.turn_id).toBe(identity.turnId);
		expect(parseTurnMetadata(clientMetadata).request_kind).toBe("turn");
	});

	it("lets explicit headers override generated compatibility defaults", async () => {
		let capturedHeaders: Headers | undefined;
		const sse = `${completedEvents()
			.map((event) => `data: ${JSON.stringify(event)}`)
			.join("\n\n")}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers as Headers;
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);

		await streamOpenAICodexResponses(model, context, {
			apiKey: token(),
			transport: "sse",
			requestIdentity: identity,
			headers: { originator: "custom", "thread-id": "custom-thread" },
		}).result();

		expect(capturedHeaders?.get("originator")).toBe("custom");
		expect(capturedHeaders?.get("thread-id")).toBe("custom-thread");
	});
});
