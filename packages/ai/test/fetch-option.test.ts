import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { streamSimple as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { streamSimple as streamMistral } from "../src/api/mistral-conversations.ts";
import { streamSimple as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { generateImages } from "../src/api/openrouter-images.ts";
import { streamSimple as streamPiMessages } from "../src/api/pi-messages.ts";
import type { Api, FetchFunction, ImageModel, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function createModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function mockFetches() {
	const fallback = vi.fn<FetchFunction>(async () => {
		throw new Error("ambient fetch must not be called");
	});
	const custom = vi.fn<FetchFunction>(
		async () =>
			new Response(JSON.stringify({ error: { message: "upstream rejected request" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fallback);
	return { custom, fallback };
}

function expectOnlyCustomFetch(
	custom: ReturnType<typeof vi.fn<FetchFunction>>,
	fallback: ReturnType<typeof vi.fn<FetchFunction>>,
) {
	expect(custom).toHaveBeenCalled();
	expect(fallback).not.toHaveBeenCalled();
	expect(globalThis.fetch).toBe(fallback);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetch stream option", () => {
	it("passes fetch through streamSimple to the Anthropic SDK", async () => {
		const { custom, fallback } = mockFetches();
		await streamAnthropic(createModel("anthropic-messages"), context, {
			apiKey: "test-key",
			fetch: custom,
			maxRetries: 0,
		}).result();
		expectOnlyCustomFetch(custom, fallback);
	});

	it("passes fetch through streamSimple to OpenAI SDK adapters", async () => {
		const adapters = [
			() =>
				streamOpenAICompletions(createModel("openai-completions"), context, {
					apiKey: "test-key",
					fetch: custom,
					maxRetries: 0,
				}).result(),
			() =>
				streamOpenAIResponses(createModel("openai-responses"), context, {
					apiKey: "test-key",
					fetch: custom,
					maxRetries: 0,
				}).result(),
			() =>
				streamAzureOpenAIResponses(createModel("azure-openai-responses"), context, {
					apiKey: "test-key",
					fetch: custom,
					maxRetries: 0,
				}).result(),
		];
		const { custom, fallback } = mockFetches();
		for (const run of adapters) {
			await run();
		}
		expect(custom).toHaveBeenCalledTimes(adapters.length);
		expect(fallback).not.toHaveBeenCalled();
		expect(globalThis.fetch).toBe(fallback);
	});

	it("uses fetch for Mistral, Codex SSE, and pi-messages HTTP requests", async () => {
		const { custom, fallback } = mockFetches();
		await streamMistral(createModel("mistral-conversations"), context, {
			apiKey: "test-key",
			fetch: custom,
		}).result();
		await streamOpenAICodexResponses(createModel("openai-codex-responses"), context, {
			apiKey: `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`,
			fetch: custom,
			transport: "sse",
			maxRetries: 0,
		}).result();
		await streamPiMessages(createModel("pi-messages"), context, {
			apiKey: "test-key",
			fetch: custom,
		}).result();
		expect(custom).toHaveBeenCalledTimes(3);
		expect(fallback).not.toHaveBeenCalled();
		expect(globalThis.fetch).toBe(fallback);
	});

	// Regression test for #12097: the Google adapters rejected a custom fetch.
	it("passes fetch through streamSimple to the Google GenAI SDK adapters", async () => {
		const { custom, fallback } = mockFetches();
		const google = await streamGoogleGenerativeAI(createModel("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch: custom,
			maxRetries: 0,
		}).result();
		const vertex = await streamGoogleVertex(createModel("google-vertex"), context, {
			apiKey: "test-key",
			fetch: custom,
			maxRetries: 0,
		}).result();

		expect(google.errorMessage).toContain("upstream rejected request");
		expect(vertex.errorMessage).toContain("upstream rejected request");
		expect(custom).toHaveBeenCalledTimes(2);
		expect(custom.mock.calls[0]?.[0].toString()).toContain("https://upstream.test/v1");
		expect(custom.mock.calls[1]?.[0].toString()).toContain("https://upstream.test/v1");
		expect(fallback).not.toHaveBeenCalled();
		expect(globalThis.fetch).toBe(fallback);
	});

	// #12097: without a fetch, @google/genai adds a per-request dispatcher that disables the
	// global dispatcher's header and body timeouts.
	it("keeps the global dispatcher for Google adapters when no fetch is given", async () => {
		const ambient = vi.fn<FetchFunction>(
			async () =>
				new Response(JSON.stringify({ error: { message: "upstream rejected request" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", ambient);
		await streamGoogleGenerativeAI(createModel("google-generative-ai"), context, { apiKey: "test-key" }).result();
		await streamGoogleVertex(createModel("google-vertex"), context, { apiKey: "test-key" }).result();

		expect(ambient).toHaveBeenCalledTimes(2);
		for (const [, init] of ambient.mock.calls) {
			expect(init).not.toHaveProperty("dispatcher");
		}
	});

	it("uses fetch for image generation", async () => {
		const { custom, fallback } = mockFetches();
		const model: ImageModel<"openrouter-images"> = {
			...createModel("openrouter-images"),
			type: "image",
			provider: "openrouter",
			output: ["image"],
		};
		await generateImages(
			model,
			{ input: [{ type: "text", text: "draw" }] },
			{
				apiKey: "test-key",
				fetch: custom,
				maxRetries: 0,
			},
		);
		expectOnlyCustomFetch(custom, fallback);
	});
});
