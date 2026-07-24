import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearOpenAICodexWebSocketContinuation,
	closeOpenAICodexWebSocketSessions,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

describe("OpenAI Codex owner-turn continuation settlement", () => {
	it("clears continuation payload state without closing a healthy socket and drops it on disposal", async () => {
		const sentBodies: Array<{
			input: unknown[];
			previous_response_id?: string;
		}> = [];
		let connections = 0;
		let responses = 0;

		class MockWebSocket {
			static OPEN = 1;
			static CLOSED = 3;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				connections += 1;
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				const body = JSON.parse(data) as {
					input: unknown[];
					previous_response_id?: string;
				};
				sentBodies.push(body);
				responses += 1;
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.completed",
							response: {
								id: `resp_${responses}`,
								status: "completed",
								output: [],
								usage: {
									input_tokens: 5,
									output_tokens: 0,
									total_tokens: 5,
								},
							},
						}),
					});
				});
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model = createModel();
		const token = mockToken();
		const sessionId = "owner-turn-session";
		const firstContext: Context = {
			systemPrompt: "You are helpful.",
			messages: [{ role: "user", content: "owner", timestamp: 1 }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			transport: "websocket-cached",
		}).result();
		const continuedContext: Context = {
			...firstContext,
			messages: [...firstContext.messages, first, { role: "user", content: "same-turn observation", timestamp: 2 }],
		};

		await streamOpenAICodexResponses(model, continuedContext, {
			apiKey: token,
			sessionId,
			transport: "websocket-cached",
		}).result();

		expect(sentBodies[0]?.previous_response_id).toBeUndefined();
		expect(sentBodies[1]).toMatchObject({
			previous_response_id: "resp_1",
			input: [{ role: "user", content: [{ type: "input_text", text: "same-turn observation" }] }],
		});

		clearOpenAICodexWebSocketContinuation(sessionId);

		const afterSettlement = await streamOpenAICodexResponses(model, continuedContext, {
			apiKey: token,
			sessionId,
			transport: "websocket-cached",
		}).result();

		expect(connections).toBe(1);
		expect(sentBodies).toHaveLength(3);
		expect(sentBodies[2]?.previous_response_id).toBeUndefined();
		expect(sentBodies[2]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "owner" }] },
			{ role: "user", content: [{ type: "input_text", text: "same-turn observation" }] },
		]);

		closeOpenAICodexWebSocketSessions(sessionId);
		const afterDisposalContext: Context = {
			...continuedContext,
			messages: [
				...continuedContext.messages,
				afterSettlement,
				{ role: "user", content: "after disposal", timestamp: 3 },
			],
		};
		await streamOpenAICodexResponses(model, afterDisposalContext, {
			apiKey: token,
			sessionId,
			transport: "websocket-cached",
		}).result();

		expect(connections).toBe(2);
		expect(sentBodies).toHaveLength(4);
		expect(sentBodies[3]?.previous_response_id).toBeUndefined();
		expect(sentBodies[3]?.input.at(-1)).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "after disposal" }],
		});
	});
});
