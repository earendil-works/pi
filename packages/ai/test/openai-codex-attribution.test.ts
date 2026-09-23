import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OpenAICodexRequestIdentity, streamSimple } from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const identity: OpenAICodexRequestIdentity = {
	sessionId: "session-1",
	threadId: "thread-1",
	turnId: "turn-1",
	requestKind: "turn",
	startedAt: 123,
	windowId: "thread-1:2",
	windowNumber: 2,
	contextWindowId: "context-2",
};

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

const completed =
	'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}\n\n';

afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
});

describe("Codex request attribution", () => {
	// #9481
	it("emits canonical metadata and keeps routing state within one turn", async () => {
		const headers: Headers[] = [];
		const bodies: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				headers.push(new Headers(init?.headers));
				return new Response(completed, {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-codex-turn-state": `state-${headers.length}`,
					},
				});
			}),
		);
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		const request = async (
			requestIdentity: OpenAICodexRequestIdentity,
			requestModel: Model<"openai-codex-responses"> = model,
		) =>
			streamSimple(requestModel, context, {
				apiKey: token(),
				transport: "sse",
				cacheRetention: "none",
				requestIdentity,
				onPayload: (body) => {
					bodies.push(body as Record<string, unknown>);
				},
			}).result();

		await request(identity);
		await request(identity);
		await request(identity, { ...model, id: "gpt-5.2-codex", name: "Codex 5.2" });
		await request({ ...identity, turnId: "turn-2", startedAt: 456 });

		expect(headers[0].get("session-id")).toBe(identity.sessionId);
		expect(headers[0].get("thread-id")).toBe(identity.threadId);
		expect(headers[0].get("x-codex-window-id")).toBe(identity.windowId);
		expect(headers[0].get("x-codex-turn-state")).toBeNull();
		expect(headers[1].get("x-codex-turn-state")).toBe("state-1");
		expect(headers[2].get("x-codex-turn-state")).toBe("state-1");
		expect(headers[3].get("x-codex-turn-state")).toBeNull();

		const clientMetadata = bodies[0].client_metadata as Record<string, string>;
		expect(clientMetadata).toMatchObject({
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
			"x-codex-window-id": identity.windowId,
		});
		expect(JSON.parse(clientMetadata["x-codex-turn-metadata"])).toMatchObject({
			window_number: 2,
			context_window_id: "context-2",
			request_kind: "turn",
			turn_started_at_unix_ms: 123,
		});
	});

	// #9481
	it("applies canonical metadata after payload and header overrides", async () => {
		const body = Object.freeze({
			model: model.id,
			input: [],
			client_metadata: Object.freeze({ turn_id: "spoofed", trace_id: "extension-trace" }),
		});
		let inspectedMetadata: Record<string, string> | undefined;
		let sentBody: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				headers = new Headers(init?.headers);
				if (typeof init?.body === "string") {
					sentBody = JSON.parse(init.body) as Record<string, unknown>;
				} else if (init?.body instanceof Uint8Array) {
					sentBody = JSON.parse(zstdDecompressSync(init.body).toString("utf8")) as Record<string, unknown>;
				}
				return new Response(completed, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);

		await streamSimple(model, normalizeContext({ messages: [] }), {
			apiKey: token(),
			transport: "sse",
			cacheRetention: "none",
			metadata: { "pi.requestIdentity": identity },
			headers: {
				originator: "spoofed",
				"session-id": "spoofed",
				"thread-id": "spoofed",
			},
			onPayload: (payload) => {
				inspectedMetadata = (payload as { client_metadata?: Record<string, string> }).client_metadata;
				return body;
			},
		}).result();

		expect(inspectedMetadata).toMatchObject({
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
		});
		expect(body.client_metadata).toEqual({ turn_id: "spoofed", trace_id: "extension-trace" });
		expect(sentBody?.client_metadata).toMatchObject({
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
			trace_id: "extension-trace",
		});
		expect(headers?.get("originator")).toBe("pi");
		expect(headers?.get("session-id")).toBe(identity.sessionId);
		expect(headers?.get("thread-id")).toBe(identity.threadId);
	});

	// #9481
	it("keeps foreground and compaction routing state independent", async () => {
		const states: Array<string | null> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				states.push(new Headers(init?.headers).get("x-codex-turn-state"));
				return new Response(completed, {
					status: 200,
					headers: { "content-type": "text/event-stream", "x-codex-turn-state": `state-${states.length}` },
				});
			}),
		);
		const context = normalizeContext({ messages: [] });
		const request = async (requestIdentity: OpenAICodexRequestIdentity) =>
			streamSimple(model, context, {
				apiKey: token(),
				transport: "sse",
				cacheRetention: "none",
				requestIdentity,
			}).result();

		await request(identity);
		await request({ ...identity, turnId: "compaction", requestKind: "compaction" });
		await request(identity);

		expect(states).toEqual([null, null, "state-1"]);
	});

	// #9481
	it("updates WebSocket metadata without invalidating cached continuation", async () => {
		const frames: Array<{
			client_metadata?: Record<string, string>;
			previous_response_id?: string;
		}> = [];
		let connections = 0;
		class MockWebSocket {
			readyState = 1;
			private listeners = new Map<string, Set<(event: unknown) => void>>();
			constructor() {
				connections++;
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
				frames.push(JSON.parse(data));
				const responseId = `response-${frames.length}`;
				queueMicrotask(() =>
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.completed",
							response: {
								id: responseId,
								status: "completed",
								output: [],
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						}),
					}),
				);
			}
			close(): void {
				this.readyState = 3;
			}
			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		const request = async (
			requestIdentity: OpenAICodexRequestIdentity,
			requestModel: Model<"openai-codex-responses"> = model,
		) =>
			streamSimple(requestModel, context, {
				apiKey: token(),
				transport: "auto",
				sessionId: identity.sessionId,
				requestIdentity,
			}).result();

		await request(identity);
		await request({ ...identity, turnId: "turn-2", startedAt: 456 });
		await request(
			{ ...identity, turnId: "turn-3", startedAt: 789 },
			{ ...model, id: "gpt-5.2-codex", name: "Codex 5.2" },
		);
		await request(
			{ ...identity, turnId: "turn-4", startedAt: 999 },
			{ ...model, id: "gpt-5.3-codex", name: "Codex 5.3", headers: { "x-model-route": "alternate" } },
		);

		expect(connections).toBe(2);
		expect(frames[0].client_metadata?.turn_id).toBe("turn-1");
		expect(frames[1].client_metadata?.turn_id).toBe("turn-2");
		expect(frames[1].previous_response_id).toBe("response-1");
		expect(frames[2].client_metadata?.turn_id).toBe("turn-3");
		expect(frames[2].previous_response_id).toBeUndefined();
		expect(frames[3].client_metadata?.turn_id).toBe("turn-4");
		expect(frames[3].previous_response_id).toBeUndefined();
	});
});
