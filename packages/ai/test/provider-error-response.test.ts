// #12376: SDK-based adapters report HTTP error responses to `onResponse`, like the fetch-based adapters do.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessageEventStream, Model, ProviderResponse, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

let server: Server | undefined;

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

/** Answers every request with 429 and `retry-after: 0`, counting requests. */
async function startRateLimitServer(): Promise<{ baseUrl: string; requests: () => number }> {
	let requests = 0;
	server = createServer((_req, res) => {
		requests++;
		res.writeHead(429, { "content-type": "application/json", "retry-after": "0", "x-request-id": "req-1" });
		res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error", code: 429 } }));
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests: () => requests };
}

function testModel<TApi extends Api>(api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

type StreamFn = (model: Model<Api>, options: StreamOptions) => AssistantMessageEventStream;

const adapters: { api: Api; stream: StreamFn; headers: boolean }[] = [
	{
		api: "openai-completions",
		stream: (m, o) => streamCompletions(m as Model<"openai-completions">, context, o),
		headers: true,
	},
	{
		api: "openai-responses",
		stream: (m, o) => streamResponses(m as Model<"openai-responses">, context, o),
		headers: true,
	},
	{
		api: "azure-openai-responses",
		stream: (m, o) => streamAzure(m as Model<"azure-openai-responses">, context, o),
		headers: true,
	},
	{
		api: "anthropic-messages",
		stream: (m, o) => streamAnthropic(m as Model<"anthropic-messages">, context, o),
		headers: true,
	},
	// @google/genai's ApiError carries no headers.
	{
		api: "google-generative-ai",
		stream: (m, o) => streamGoogle(m as Model<"google-generative-ai">, context, o),
		headers: false,
	},
];

describe("provider error responses", () => {
	for (const adapter of adapters) {
		it(`${adapter.api} reports each failed attempt to onResponse`, async () => {
			const { baseUrl, requests } = await startRateLimitServer();
			const responses: ProviderResponse[] = [];

			const result = await adapter
				.stream(testModel(adapter.api, baseUrl), {
					apiKey: "test-key",
					maxRetries: 1,
					onResponse: (response) => void responses.push(response),
				})
				.result();

			expect(result.stopReason).toBe("error");
			expect(requests()).toBe(2);
			expect(responses.map((response) => response.status)).toEqual([429, 429]);
			if (adapter.headers) {
				expect(responses[0].headers["retry-after"]).toBe("0");
				expect(responses[0].headers["x-request-id"]).toBe("req-1");
			} else {
				expect(responses[0].headers).toEqual({});
			}
		});
	}
});
