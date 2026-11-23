import { describe, expect, it } from "vitest";
import { streamSimple as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
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

function createFetch(body: string): FetchFunction {
	return async () =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
}

const safetyRatings = [
	{
		category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
		probability: "HIGH",
	},
];

const adapters = [
	{
		name: "Google Generative AI",
		feedback: { blockReason: "PROHIBITED_CONTENT", safetyRatings },
		expectedBlockError:
			"Google prompt blocked: PROHIBITED_CONTENT. Safety rating: HARM_CATEGORY_SEXUALLY_EXPLICIT (HIGH)",
		expectedEmptyError: "Google stream ended without a finish reason after receiving 0 chunks",
		createStream: (fetch: FetchFunction) =>
			streamGoogleGenerativeAI(createModel("google-generative-ai"), context, { apiKey: "test-key", fetch }),
	},
	{
		name: "Google Vertex",
		feedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "Blocked by policy", safetyRatings },
		expectedBlockError:
			"Google Vertex prompt blocked: PROHIBITED_CONTENT. Blocked by policy. Safety rating: HARM_CATEGORY_SEXUALLY_EXPLICIT (HIGH)",
		expectedEmptyError: "Google Vertex stream ended without a finish reason after receiving 0 chunks",
		createStream: (fetch: FetchFunction) =>
			streamGoogleVertex(createModel("google-vertex"), context, { apiKey: "test-key", fetch }),
	},
];

describe("Google stream errors", () => {
	// Regression for #12330.
	it.each(adapters)(
		"distinguishes a blocked prompt from an empty $name stream",
		async ({ feedback, expectedBlockError, expectedEmptyError, createStream }) => {
			const blocked = await createStream(
				createFetch(`data: ${JSON.stringify({ promptFeedback: feedback })}\n\n`),
			).result();
			const empty = await createStream(createFetch("")).result();

			expect(blocked.stopReason).toBe("error");
			expect(blocked.errorMessage).toBe(expectedBlockError);
			expect(isRetryableAssistantError(blocked)).toBe(false);
			expect(empty.stopReason).toBe("error");
			expect(empty.errorMessage).toBe(expectedEmptyError);
			expect(isRetryableAssistantError(empty)).toBe(true);
		},
	);
});
