import { FinishReason } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { streamSimple as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { mapStopReason } from "../src/api/google-shared.ts";
import { streamSimple as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
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

describe("Google CONTINUATION finish reason", () => {
	// #12097: @google/genai 2.32.0, needed for httpOptions.fetch, adds FinishReason.CONTINUATION.
	it("maps CONTINUATION to length, like MAX_TOKENS", () => {
		expect(mapStopReason(FinishReason.CONTINUATION)).toBe("length");
	});

	// #12097: the SDK continues automatically by default; the adapters turn that off.
	it("ends the turn as length instead of letting the SDK send a continuation request", async () => {
		const chunk = {
			candidates: [
				{
					content: { role: "model", parts: [{ text: "partial" }] },
					finishReason: "CONTINUATION",
					continuationToken: "token-1",
				},
			],
		};
		const fetch = vi.fn<FetchFunction>(
			async () =>
				new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
		);

		const google = await streamGoogleGenerativeAI(createModel("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch,
		}).result();
		const vertex = await streamGoogleVertex(createModel("google-vertex"), context, {
			apiKey: "test-key",
			fetch,
		}).result();

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(google.stopReason).toBe("length");
		expect(vertex.stopReason).toBe("length");
	});
});
