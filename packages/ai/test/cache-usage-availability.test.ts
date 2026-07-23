import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import {
	type AssistantMessage,
	CACHE_USAGE_AVAILABILITY_BY_API,
	type Context,
	CUSTOM_API_CACHE_USAGE_AVAILABILITY,
	type Model,
	normalizeCacheTokenUsage,
	type Usage,
} from "../src/index.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

type RawCompletionsUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
	};
};

const completionsState = vi.hoisted(() => ({
	usage: {} as RawCompletionsUsage,
	requests: 0,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					completionsState.requests += 1;
					const responseStream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: completionsState.usage,
							};
						},
					};
					const request = Promise.resolve(responseStream) as Promise<typeof responseStream> & {
						withResponse(): Promise<{
							data: typeof responseStream;
							response: { status: number; headers: Headers };
						}>;
					};
					request.withResponse = async () => ({
						data: responseStream,
						response: { status: 200, headers: new Headers() },
					});
					return request;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function createModel<TApi extends "openai-completions" | "openai-responses">(api: TApi): Model<TApi> {
	return {
		id: "cache-usage-test",
		name: "Cache usage test",
		api,
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} as Model<TApi>;
}

function createOutput<TApi extends "openai-responses">(model: Model<TApi>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function parseResponsesUsage(inputTokenDetails: unknown): Promise<Usage> {
	const model = createModel("openai-responses");
	const output = createOutput(model);
	const providerStream = {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "response.completed",
				response: {
					id: "resp_usage",
					status: "completed",
					output: [],
					usage: {
						input_tokens: 20,
						output_tokens: 3,
						total_tokens: 23,
						input_tokens_details: inputTokenDetails,
					},
				},
			};
		},
	};

	await processResponsesStream(providerStream as never, output, new AssistantMessageEventStream(), model);
	return output.usage;
}

describe("cache usage availability", () => {
	beforeEach(() => {
		completionsState.usage = {};
		completionsState.requests = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps every KnownApi and the custom default explicitly classified", () => {
		expect(CACHE_USAGE_AVAILABILITY_BY_API).toEqual({
			"openai-completions": { read: "raw-field-presence", write: "raw-field-presence" },
			"mistral-conversations": { read: "raw-field-presence", write: "unavailable" },
			"openai-responses": { read: "raw-field-presence", write: "raw-field-presence" },
			"azure-openai-responses": { read: "raw-field-presence", write: "raw-field-presence" },
			"openai-codex-responses": { read: "raw-field-presence", write: "raw-field-presence" },
			"anthropic-messages": { read: "raw-field-presence", write: "raw-field-presence" },
			"bedrock-converse-stream": { read: "raw-field-presence", write: "raw-field-presence" },
			"google-generative-ai": { read: "raw-field-presence", write: "unavailable" },
			"google-vertex": { read: "raw-field-presence", write: "unavailable" },
			"pi-messages": { read: "protocol-field-presence", write: "protocol-field-presence" },
		});
		expect(CUSTOM_API_CACHE_USAGE_AVAILABILITY).toEqual({
			read: "unavailable",
			write: "unavailable",
		});
	});

	it.each([
		["positive", 17, { tokens: 17, reported: true }],
		["explicit zero", 0, { tokens: 0, reported: true }],
		["absent", undefined, { tokens: 0, reported: false }],
		["negative", -1, { tokens: 0, reported: false }],
		["fractional", 1.5, { tokens: 0, reported: false }],
		["NaN", Number.NaN, { tokens: 0, reported: false }],
		["infinite", Number.POSITIVE_INFINITY, { tokens: 0, reported: false }],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1, { tokens: 0, reported: false }],
		["numeric string", "17", { tokens: 0, reported: false }],
	] as const)("normalizes %s cache token counts without conflating absence and zero", (_label, raw, expected) => {
		expect(normalizeCacheTokenUsage(raw)).toEqual(expected);
	});

	it("tracks OpenAI Responses read and write field presence independently", async () => {
		await expect(parseResponsesUsage({ cached_tokens: 0, cache_write_tokens: 7 })).resolves.toMatchObject({
			cacheRead: 0,
			cacheReadReported: true,
			cacheWrite: 7,
			cacheWriteReported: true,
		});

		await expect(parseResponsesUsage({ cache_write_tokens: 0 })).resolves.toMatchObject({
			cacheRead: 0,
			cacheReadReported: false,
			cacheWrite: 0,
			cacheWriteReported: true,
		});

		await expect(parseResponsesUsage({ cached_tokens: -3 })).resolves.toMatchObject({
			cacheRead: 0,
			cacheReadReported: false,
			cacheWrite: 0,
			cacheWriteReported: false,
		});
	});

	it("tracks OpenAI Chat Completions read and write field presence independently", async () => {
		const model = createModel("openai-completions");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};

		completionsState.usage = {
			prompt_tokens: 12,
			completion_tokens: 2,
			prompt_tokens_details: { cached_tokens: 0 },
		};
		const explicitZeroRead = await streamOpenAICompletions(model, context, {
			apiKey: "test",
		}).result();
		expect(explicitZeroRead.usage).toMatchObject({
			cacheRead: 0,
			cacheReadReported: true,
			cacheWrite: 0,
			cacheWriteReported: false,
		});

		completionsState.usage = {
			prompt_tokens: 12,
			completion_tokens: 2,
			prompt_tokens_details: { cache_write_tokens: 4 },
		};
		const positiveWrite = await streamOpenAICompletions(model, context, {
			apiKey: "test",
		}).result();
		expect(positiveWrite.usage).toMatchObject({
			cacheRead: 0,
			cacheReadReported: false,
			cacheWrite: 4,
			cacheWriteReported: true,
		});

		completionsState.usage = {
			prompt_tokens: 12,
			completion_tokens: 2,
			prompt_tokens_details: { cached_tokens: -1, cache_write_tokens: 1.5 },
		};
		const invalid = await streamOpenAICompletions(model, context, {
			apiKey: "test",
		}).result();
		expect(invalid.usage).toMatchObject({
			cacheRead: 0,
			cacheReadReported: false,
			cacheWrite: 0,
			cacheWriteReported: false,
		});
		expect(completionsState.requests).toBe(3);
	});

	it("keeps the availability fields optional for providers that report neither metric", () => {
		const usage: Usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		expect(usage.cacheReadReported).toBeUndefined();
		expect(usage.cacheWriteReported).toBeUndefined();
	});
});
