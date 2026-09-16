import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
	streamSimple as streamSimpleOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AgentRequestIdentity, Context, Model } from "../src/types.ts";

afterEach(() => {
	cleanupSessionResources();
	resetOpenAICodexWebSocketDebugStats();
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

function token(accountId = "account-1"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

function completedEvents(responseId = "response-1"): Array<Record<string, unknown>> {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
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

function captureWebSocketRequests(
	eventsForRequest = (index: number) => completedEvents(`response-${index}`),
	openConnection: (open: () => void, fail: () => void) => void = queueMicrotask,
) {
	const handshakes: Array<Record<string, string> | undefined> = [];
	const urls: string[] = [];
	const sockets: MockWebSocket[] = [];
	const frames: Array<{
		input: Array<Record<string, unknown>>;
		previous_response_id?: string;
		client_metadata?: Record<string, string>;
	}> = [];
	class MockWebSocket {
		readyState = 1;
		private listeners = new Map<string, Set<(event: unknown) => void>>();
		constructor(_url: string, options?: { headers?: Record<string, string> }) {
			sockets.push(this);
			urls.push(_url);
			handshakes.push(options?.headers);
			openConnection(
				() => this.dispatch("open", {}),
				() => this.dispatch("error", { message: "Handshake failed" }),
			);
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
			const events = eventsForRequest(frames.length);
			queueMicrotask(() => {
				for (const event of events) {
					if (event.type === "test.close") this.close();
					else this.dispatch("message", { data: JSON.stringify(event) });
				}
			});
		}
		close(): void {
			this.readyState = 3;
			this.dispatch("close", { code: 1006 });
		}
		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}
	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected HTTP fallback");
		}),
	);
	return { handshakes, frames, urls, sockets };
}

function parseTurnMetadata(clientMetadata: Record<string, string>): Record<string, unknown> {
	return JSON.parse(clientMetadata["x-codex-turn-metadata"]);
}

function decodeRequestBody(body: RequestInit["body"] | undefined): Record<string, unknown> | undefined {
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as Record<string, unknown>;
	}
	return undefined;
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
				capturedBody = decodeRequestBody(init?.body);
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

	// #9481: new-turn attribution must not discard an otherwise valid input delta.
	it.each(["auto", "websocket-cached", "websocket"] as const)(
		"sends current metadata on reused %s frames without invalidating cached input",
		async (transport) => {
			const { handshakes, frames } = captureWebSocketRequests();
			const nextIdentity = { ...identity, turnId: "turn-2", startedAt: identity.startedAt + 1000 };
			const messages = [...context.messages];
			for (const requestIdentity of [identity, nextIdentity, undefined]) {
				const result = await streamOpenAICodexResponses(
					model,
					{ ...context, messages },
					{
						apiKey: token(),
						transport,
						sessionId: identity.sessionId,
						requestIdentity,
					},
				).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toMatchObject([{ type: "text", text: "Hello" }]);
				messages.push(result, { role: "user", content: "next", timestamp: 2 });
			}
			expect(handshakes).toHaveLength(1);
			expect(handshakes[0]?.["session-id"]).toBe(identity.sessionId);
			expect(handshakes[0]?.["thread-id"]).toBe(identity.threadId);
			expect(handshakes[0]?.["x-client-request-id"]).toBe(identity.threadId);
			expect(JSON.parse(handshakes[0]!["x-codex-turn-metadata"]).turn_id).toBe(identity.turnId);
			expect(frames.map((frame) => frame.client_metadata?.turn_id)).toEqual([
				identity.turnId,
				nextIdentity.turnId,
				undefined,
			]);
			expect(parseTurnMetadata(frames[1].client_metadata!)).toMatchObject({
				turn_id: nextIdentity.turnId,
				turn_started_at_unix_ms: nextIdentity.startedAt,
				request_kind: "turn",
			});
			expect(frames[2].client_metadata).toBeUndefined();
			expect(frames.map((frame) => frame.previous_response_id)).toEqual(
				transport === "websocket" ? [undefined, undefined, undefined] : [undefined, "response-1", "response-2"],
			);
			expect(frames.map((frame) => frame.input.length)).toEqual(transport === "websocket" ? [1, 3, 5] : [1, 1, 1]);
			expect(frames[1].input.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "input_text", text: "next" }],
			});
		},
	);

	it.each(["instructions", "tools", "reasoning", "prefix", "shorter context"])(
		"still resends full input when metadata and %s change",
		async (change) => {
			const { frames } = captureWebSocketRequests();
			const options = {
				apiKey: token(),
				transport: "auto" as const,
				sessionId: identity.sessionId,
				requestIdentity: identity,
			};
			const first = await streamOpenAICodexResponses(model, context, options).result();
			expect(first.stopReason).toBe("stop");
			const nextContext: Context = {
				...context,
				messages: [...context.messages, first, { role: "user", content: "next", timestamp: 2 }],
			};
			if (change === "instructions") nextContext.systemPrompt = "Different instructions.";
			if (change === "tools")
				nextContext.tools = [{ name: "probe", description: "A new tool", parameters: Type.Object({}) }];
			if (change === "prefix") nextContext.messages[0] = { role: "user", content: "changed", timestamp: 1 };
			if (change === "shorter context") nextContext.messages = [{ role: "user", content: "next", timestamp: 2 }];
			const second = await streamOpenAICodexResponses(model, nextContext, {
				...options,
				requestIdentity: { ...identity, turnId: "turn-2", startedAt: 987654321 },
				...(change === "reasoning" ? { reasoningEffort: "high" as const } : {}),
			}).result();
			expect(second.stopReason).toBe("stop");
			expect(frames).toHaveLength(2);
			expect(frames[1].previous_response_id).toBeUndefined();
			expect(frames[1].input).toHaveLength(change === "shorter context" ? 1 : 3);
			expect(frames[1].client_metadata?.turn_id).toBe("turn-2");
		},
	);

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

// #9481: routing state belongs to a logical turn, not a socket or prompt-cache key.
describe("OpenAI Codex turn routing", () => {
	const options = {
		apiKey: token(),
		transport: "sse" as const,
		requestIdentity: identity,
		cacheRetention: "none" as const,
	};
	function captureSSE(responseForRequest: (index: number) => Response = () => sseResponse()) {
		const headers: Headers[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				headers.push(new Headers(init?.headers));
				return responseForRequest(headers.length);
			}),
		);
		return headers;
	}
	function sseResponse(state = "first", events = completedEvents()): Response {
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream", "x-codex-turn-state": state },
		});
	}
	const metadata = (state: unknown, type = "codex.response.metadata") => ({
		type,
		headers: { "x-codex-turn-state": state },
	});

	it("keeps the first HTTP state through continuations and intervening compaction, but not new turns", async () => {
		const headers = captureSSE((index) => sseResponse(`state-${index}`));
		for (const requestIdentity of [
			identity,
			identity,
			{ ...identity, turnId: "summary", requestKind: "compaction" as const },
			{ ...identity, windowId: "thread-1:1" },
			{ ...identity, turnId: "next" },
		]) {
			expect(
				(await streamOpenAICodexResponses(model, context, { ...options, requestIdentity }).result()).stopReason,
			).toBe("stop");
		}
		expect(headers.map((h) => h.get("x-codex-turn-state"))).toEqual([null, "state-1", null, "state-1", null]);
	});

	it("captures state on a retryable HTTP failure before the internal retry", async () => {
		const headers = captureSSE((index) =>
			index === 1
				? new Response("overloaded", {
						status: 503,
						headers: { "retry-after-ms": "0", "x-codex-turn-state": "retry-state" },
					})
				: sseResponse(),
		);
		expect(
			(await streamOpenAICodexResponses(model, context, { ...options, maxRetries: 1 }).result()).stopReason,
		).toBe("stop");
		expect(headers.map((h) => h.get("x-codex-turn-state"))).toEqual([null, "retry-state"]);
	});

	it.each(["codex.response.metadata", "response.metadata"])(
		"captures %s and replays it on frames and reconnects",
		async (type) => {
			const { frames, handshakes } = captureWebSocketRequests((index) => [
				metadata(`state-${index}`, type),
				...completedEvents(`response-${index}`),
			]);
			const wsOptions = {
				...options,
				transport: "auto" as const,
				cacheRetention: "short" as const,
				sessionId: identity.sessionId,
			};
			const messages = [...context.messages];
			for (let index = 0; index < 4; index++) {
				if (index === 2) closeOpenAICodexWebSocketSessions(identity.sessionId);
				const result = await streamOpenAICodexResponses(
					model,
					{ ...context, messages },
					{ ...wsOptions, requestIdentity: index === 3 ? { ...identity, turnId: "next" } : identity },
				).result();
				expect(result.stopReason).toBe("stop");
				messages.push(result, { role: "user", content: "next", timestamp: 2 });
			}
			expect(frames.map((f) => f.client_metadata?.["x-codex-turn-state"])).toEqual([
				undefined,
				"state-1",
				"state-1",
				undefined,
			]);
			expect(handshakes.map((h) => h?.["x-codex-turn-state"])).toEqual([undefined, undefined]);
			expect(frames[1].previous_response_id).toBe("response-1");
		},
	);

	it("preserves metadata received before a transport failure for immediate SSE fallback", async () => {
		captureWebSocketRequests(() => [metadata("before-close"), { type: "test.close" }]);
		const headers = captureSSE();
		expect(
			(
				await streamOpenAICodexResponses(model, context, {
					...options,
					transport: "auto",
					sessionId: identity.sessionId,
				}).result()
			).stopReason,
		).toBe("stop");
		expect(headers[0].get("x-codex-turn-state")).toBe("before-close");
	});

	it("preserves state after streamed output fails, without silently retrying partial output", async () => {
		captureWebSocketRequests(() => [metadata("partial"), ...completedEvents().slice(0, 3), { type: "test.close" }]);
		const headers = captureSSE();
		const retryOptions = {
			...options,
			transport: "auto" as const,
			cacheRetention: "short" as const,
			sessionId: identity.sessionId,
		};
		expect((await streamOpenAICodexResponses(model, context, retryOptions).result()).stopReason).toBe("error");
		expect(headers).toHaveLength(0);
		expect((await streamOpenAICodexResponses(model, context, retryOptions).result()).stopReason).toBe("stop");
		expect(headers[0].get("x-codex-turn-state")).toBe("partial");
	});

	it.each(["account", "endpoint", "cleanup", "thread", "session"])(
		"isolates routing after %s changes",
		async (change) => {
			const headers = captureSSE();
			await streamOpenAICodexResponses(model, context, options).result();
			if (change === "cleanup") cleanupSessionResources(identity.sessionId);
			await streamOpenAICodexResponses(
				change === "endpoint" ? { ...model, baseUrl: "https://example.test" } : model,
				context,
				{
					...options,
					apiKey: change === "account" ? token("account-2") : token(),
					requestIdentity: {
						...identity,
						...(change === "thread" ? { threadId: "other" } : change === "session" ? { sessionId: "other" } : {}),
					},
				},
			).result();
			expect(headers[1].get("x-codex-turn-state")).toBeNull();
			if (change === "account" || change === "endpoint") {
				await streamOpenAICodexResponses(model, context, options).result();
				expect(headers[2].get("x-codex-turn-state")).toBeNull();
			}
		},
	);

	it.each(["custom", null])("honors a case-insensitive explicit routing override: %s", async (override) => {
		const { frames, handshakes } = captureWebSocketRequests((index) => [
			metadata("server"),
			...completedEvents(`response-${index}`),
		]);
		await streamOpenAICodexResponses(model, context, { ...options, transport: "websocket" }).result();
		await streamOpenAICodexResponses({ ...model, headers: { "X-Codex-Turn-State": "model" } }, context, {
			...options,
			transport: "websocket",
			headers: { "X-CODEX-TURN-STATE": override },
		}).result();
		expect(handshakes[1]?.["x-codex-turn-state"]).toBe(override ?? undefined);
		expect(frames[1].client_metadata?.["x-codex-turn-state"]).toBe(override ?? undefined);
	});

	it("does not infer a logical turn from cache identity", async () => {
		const headers = captureSSE();
		for (let i = 0; i < 2; i++)
			await streamOpenAICodexResponses(model, context, {
				...options,
				requestIdentity: undefined,
				sessionId: "cache",
			}).result();
		expect(headers.map((h) => h.get("x-codex-turn-state"))).toEqual([null, null]);
	});

	it("captures SSE metadata when no response header carries state", async () => {
		const headers = captureSSE(() => sseResponse("", [metadata("event-state"), ...completedEvents()]));
		for (let i = 0; i < 2; i++) {
			expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe("stop");
		}
		expect(headers.map((h) => h.get("x-codex-turn-state"))).toEqual([null, "event-state"]);
	});

	it("does not restore cleaned-up state when an in-flight request completes", async () => {
		const headers = captureSSE(() => {
			cleanupSessionResources(identity.sessionId);
			return sseResponse("late-state");
		});
		for (let i = 0; i < 2; i++) await streamOpenAICodexResponses(model, context, options).result();
		expect(headers.map((h) => h.get("x-codex-turn-state"))).toEqual([null, null]);
	});

	it("replays state on the internal WebSocket connection-limit retry, never its handshake", async () => {
		const { frames, handshakes } = captureWebSocketRequests((index) =>
			index === 1
				? [
						metadata("retry-state"),
						{ type: "error", code: "websocket_connection_limit_reached", message: "reconnect" },
					]
				: completedEvents(),
		);
		expect(
			(await streamOpenAICodexResponses(model, context, { ...options, transport: "auto" }).result()).stopReason,
		).toBe("stop");
		expect(frames.map((f) => f.client_metadata?.["x-codex-turn-state"])).toEqual([undefined, "retry-state"]);
		expect(handshakes.map((h) => h?.["x-codex-turn-state"])).toEqual([undefined, undefined]);
	});

	it("ignores invalid event values without blocking later valid state", async () => {
		const { frames } = captureWebSocketRequests((index) => [
			metadata({ bad: true }),
			metadata("invalid\r\nheader"),
			metadata("valid"),
			...completedEvents(`response-${index}`),
		]);
		for (let i = 0; i < 2; i++)
			expect(
				(await streamOpenAICodexResponses(model, context, { ...options, transport: "websocket" }).result())
					.stopReason,
			).toBe("stop");
		expect(frames[1].client_metadata?.["x-codex-turn-state"]).toBe("valid");
	});

	it("does not let unrelated sessions evict a foreground turn", async () => {
		const headers = captureSSE();
		await streamOpenAICodexResponses(model, context, options).result();
		for (let i = 0; i < 257; i++)
			await streamOpenAICodexResponses(model, context, {
				...options,
				requestIdentity: { ...identity, sessionId: `session-${i}`, threadId: `thread-${i}`, turnId: `turn-${i}` },
			}).result();
		await streamOpenAICodexResponses(model, context, options).result();
		expect(headers.at(-1)?.get("x-codex-turn-state")).toBe("first");
	});

	it.each([
		["account", "open"],
		["account", "fail"],
		["endpoint", "open"],
		["endpoint", "fail"],
		["cleanup", "open"],
		["cleanup", "fail"],
	])("isolates a stale handshake after %s changes when it settles with %s", async (change, outcome) => {
		const opens: Array<() => void> = [];
		const failures: Array<() => void> = [];
		const { frames, handshakes } = captureWebSocketRequests(undefined, (open, fail) => {
			opens.push(open);
			failures.push(fail);
		});
		const wsOptions = {
			...options,
			transport: "auto" as const,
			cacheRetention: "short" as const,
			sessionId: identity.sessionId,
		};
		const pending = streamOpenAICodexResponses(model, context, wsOptions).result();
		await vi.waitFor(() => expect(opens).toHaveLength(1));
		if (change === "cleanup") cleanupSessionResources(identity.sessionId);
		const currentOptions = { ...wsOptions, apiKey: change === "account" ? token("account-2") : token() };
		const currentModel = change === "endpoint" ? { ...model, baseUrl: "https://other.test" } : model;
		const current = streamOpenAICodexResponses(currentModel, context, currentOptions).result();
		await vi.waitFor(() => expect(opens).toHaveLength(2));
		opens[1]();
		expect((await current).stopReason).toBe("stop");
		if (outcome === "open") opens[0]();
		else failures[0]();
		expect((await pending).stopReason).toBe("error");
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect((await streamOpenAICodexResponses(currentModel, context, currentOptions).result()).stopReason).toBe(
			"stop",
		);
		expect(frames).toHaveLength(2);
		expect(handshakes).toHaveLength(2);
	});

	it("keeps only one cached connection when concurrent handshakes complete", async () => {
		const opens: Array<() => void> = [];
		const { sockets, handshakes } = captureWebSocketRequests(undefined, (open) => opens.push(open));
		const wsOptions = {
			...options,
			transport: "auto" as const,
			cacheRetention: "short" as const,
			sessionId: identity.sessionId,
		};
		const first = streamOpenAICodexResponses(model, context, wsOptions).result();
		const second = streamOpenAICodexResponses(model, context, wsOptions).result();
		await vi.waitFor(() => expect(opens).toHaveLength(2));
		opens[0]();
		expect((await first).stopReason).toBe("stop");
		opens[1]();
		expect((await second).stopReason).toBe("stop");
		expect(sockets.map((socket) => socket.readyState)).toEqual([1, 3]);
		expect((await streamOpenAICodexResponses(model, context, wsOptions).result()).stopReason).toBe("stop");
		expect(handshakes).toHaveLength(2);
		cleanupSessionResources(identity.sessionId);
		expect(sockets.map((socket) => socket.readyState)).toEqual([3, 3]);
	});

	it("invalidates a cached socket when an intervening SSE request changes account", async () => {
		const { handshakes, frames } = captureWebSocketRequests();
		const wsOptions = {
			...options,
			transport: "auto" as const,
			cacheRetention: "short" as const,
			sessionId: identity.sessionId,
		};
		await streamOpenAICodexResponses(model, context, wsOptions).result();
		captureSSE();
		await streamOpenAICodexResponses(model, context, {
			...wsOptions,
			transport: "sse",
			apiKey: token("account-2"),
		}).result();
		await streamOpenAICodexResponses(model, context, wsOptions).result();
		expect(handshakes).toHaveLength(2);
		expect(frames.map((f) => f.previous_response_id)).toEqual([undefined, undefined]);
	});

	it("discards the previous foreground turn when a new one starts", async () => {
		const headers = captureSSE();
		for (const turnId of ["old", "new", "old"]) {
			await streamOpenAICodexResponses(model, context, {
				...options,
				requestIdentity: { ...identity, turnId },
			}).result();
		}
		expect(headers.map((h) => h.get("x-codex-turn-state"))).toEqual([null, null, null]);
	});

	it.each(["account", "endpoint"])(
		"reconnects and drops continuation state on %s changes and return",
		async (change) => {
			const { frames, handshakes, urls } = captureWebSocketRequests((index) => [
				metadata(`state-${index}`),
				...completedEvents(`response-${index}`),
			]);
			const messages = [...context.messages];
			for (let index = 0; index < 3; index++) {
				const result = await streamOpenAICodexResponses(
					index === 1 && change === "endpoint" ? { ...model, baseUrl: "https://other.test" } : model,
					{ ...context, messages },
					{
						...options,
						transport: "auto",
						cacheRetention: "short",
						sessionId: identity.sessionId,
						apiKey: index === 1 && change === "account" ? token("account-2") : token(),
					},
				).result();
				expect(result.stopReason).toBe("stop");
				messages.push(result, { role: "user", content: "next", timestamp: 2 });
			}
			expect(handshakes).toHaveLength(3);
			expect(frames.map((f) => f.previous_response_id)).toEqual([undefined, undefined, undefined]);
			expect(frames.map((f) => f.client_metadata?.["x-codex-turn-state"])).toEqual([
				undefined,
				undefined,
				undefined,
			]);
			if (change === "endpoint") expect(urls[1]).toBe("wss://other.test/codex/responses");
			else expect(handshakes[1]?.["chatgpt-account-id"]).toBe("account-2");
		},
	);
});
