import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import { streamMistral } from "../src/providers/mistral.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * Regression coverage for the optional `fetch` hook on StreamOptions
 * Providers must thread the caller-supplied fetch implementation
 * into the underlying SDK client or use it for raw HTTP transport.
 */

const openaiState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(opts: Record<string, unknown>) {
			openaiState.constructorOpts = opts;
		}

		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-fetch-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-fetch-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};

		responses = {
			create: () => {
				const stream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "response.completed", response: { status: "completed" } };
					},
				};
				const promise = Promise.resolve(stream) as Promise<typeof stream> & {
					withResponse: () => Promise<{
						data: typeof stream;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: stream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI, AzureOpenAI: FakeOpenAI };
});

const anthropicState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_fetch_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			anthropicState.constructorOpts = opts;
		}
		messages = {
			create: () => ({
				asResponse: async () => createSseResponse(),
			}),
		};
	}

	return { default: FakeAnthropic };
});

const mistralState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	httpClientOpts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@mistralai/mistralai", () => {
	class FakeHTTPClient {
		constructor(opts: Record<string, unknown>) {
			mistralState.httpClientOpts = opts;
		}
	}

	class FakeMistral {
		constructor(opts: Record<string, unknown>) {
			mistralState.constructorOpts = opts;
		}
		chat = {
			stream: () =>
				Promise.resolve({
					async *[Symbol.asyncIterator]() {
						yield {
							data: {
								id: "mistral-fetch-test",
								choices: [{ delta: { content: "ok" }, finishReason: "stop" }],
								usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
							},
						};
					},
				}),
		};
	}

	return { Mistral: FakeMistral, HTTPClient: FakeHTTPClient };
});

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

describe("StreamOptions.fetch", () => {
	it("passes options.fetch to the OpenAI SDK for openai-completions", async () => {
		openaiState.constructorOpts = undefined;
		const customFetch: typeof fetch = async () => new Response();
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model: Model<"openai-completions"> = { ...baseModel, api: "openai-completions" };

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test",
			fetch: customFetch,
		});
		for await (const _event of stream) {
			void _event;
		}

		const opts = openaiState.constructorOpts as Record<string, unknown> | undefined;
		expect(opts).toBeDefined();
		expect(opts?.fetch).toBe(customFetch);
	});

	it("omits the fetch option when none is provided", async () => {
		openaiState.constructorOpts = undefined;
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model: Model<"openai-completions"> = { ...baseModel, api: "openai-completions" };

		const stream = streamOpenAICompletions(model, context, { apiKey: "test" });
		for await (const _event of stream) {
			void _event;
		}

		const opts = openaiState.constructorOpts as Record<string, unknown> | undefined;
		expect(opts).toBeDefined();
		expect(opts && "fetch" in opts).toBe(false);
	});

	it("passes options.fetch to the OpenAI SDK for openai-responses", async () => {
		openaiState.constructorOpts = undefined;
		const customFetch: typeof fetch = async () => new Response();
		const baseModel = getModel("openai", "gpt-4o-mini")!;
		const model: Model<"openai-responses"> = {
			...baseModel,
			api: "openai-responses",
			compat: undefined,
		} as Model<"openai-responses">;

		const stream = streamOpenAIResponses(model, context, {
			apiKey: "test",
			fetch: customFetch,
		});
		for await (const _event of stream) {
			void _event;
		}

		const opts = openaiState.constructorOpts as Record<string, unknown> | undefined;
		expect(opts).toBeDefined();
		expect(opts?.fetch).toBe(customFetch);
	});

	it("passes options.fetch to the Anthropic SDK", async () => {
		anthropicState.constructorOpts = undefined;
		const customFetch: typeof fetch = async () => new Response();
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const stream = streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			fetch: customFetch,
		});
		for await (const _event of stream) {
			void _event;
		}

		const opts = anthropicState.constructorOpts as Record<string, unknown> | undefined;
		expect(opts).toBeDefined();
		expect(opts?.fetch).toBe(customFetch);
	});

	it("omits the fetch option from the Anthropic SDK when none is provided", async () => {
		anthropicState.constructorOpts = undefined;
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _event of stream) {
			void _event;
		}

		const opts = anthropicState.constructorOpts as Record<string, unknown> | undefined;
		expect(opts).toBeDefined();
		expect(opts && "fetch" in opts).toBe(false);
	});

	it("wraps options.fetch with HTTPClient for Mistral", async () => {
		mistralState.constructorOpts = undefined;
		mistralState.httpClientOpts = undefined;
		const customFetch: typeof fetch = async () => new Response();
		const model = getModel("mistral", "mistral-medium-3.5");

		const stream = streamMistral(model, context, {
			apiKey: "test",
			fetch: customFetch,
		});
		for await (const _event of stream) {
			void _event;
		}

		const httpOpts = mistralState.httpClientOpts as Record<string, unknown> | undefined;
		const sdkOpts = mistralState.constructorOpts as Record<string, unknown> | undefined;
		expect(httpOpts?.fetcher).toBe(customFetch);
		expect(sdkOpts?.httpClient).toBeDefined();
	});

	it("propagates options.fetch through buildBaseOptions for streamSimple*", async () => {
		anthropicState.constructorOpts = undefined;
		const customFetch: typeof fetch = async () => new Response();
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const stream = streamSimpleAnthropic(model, context, {
			apiKey: "sk-ant-test",
			fetch: customFetch,
		});
		for await (const _event of stream) {
			void _event;
		}

		const opts = anthropicState.constructorOpts as Record<string, unknown> | undefined;
		expect(opts?.fetch).toBe(customFetch);
	});

	it("uses options.fetch for the raw HTTP transport in openai-codex-responses", async () => {
		const calls: Array<{ url: string }> = [];
		const sseBody = `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test" } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`;
		const customFetch: typeof fetch = async (input) => {
			calls.push({ url: typeof input === "string" ? input : String(input) });
			return new Response(sseBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		// Construct a Codex JWT-shaped token so accountId extraction succeeds.
		const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
		).toString("base64url");
		const fakeJwt = `${header}.${payload}.sig`;

		const model = getModel("openai-codex", "gpt-5.3-codex");
		const stream = streamOpenAICodexResponses(model, context, {
			apiKey: fakeJwt,
			fetch: customFetch,
			transport: "sse",
		});
		for await (const _event of stream) {
			void _event;
		}

		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0].url).toContain("/codex/responses");
	});
});
