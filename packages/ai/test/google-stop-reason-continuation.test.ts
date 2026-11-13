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

	it("resumes a CONTINUATION stop with its token in the same turn", async () => {
		const sse = (chunk: unknown) =>
			new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		const run = async (
			start: (fetch: FetchFunction) => Promise<{
				stopReason: string;
				content: unknown;
				usage: { input: number; output: number; totalTokens: number };
			}>,
		) => {
			const bodies: Array<Record<string, unknown>> = [];
			const hops = [
				sse({
					candidates: [
						{
							content: { role: "model", parts: [{ text: "part" }] },
							finishReason: "CONTINUATION",
							continuationToken: "token-1",
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
				}),
				sse({
					candidates: [{ content: { role: "model", parts: [{ text: " two" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 3, totalTokenCount: 18 },
				}),
			];
			const fetch = vi.fn<FetchFunction>(async (_url, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return hops.shift()!;
			});
			const message = await start(fetch);
			return { bodies, message };
		};

		for (const start of [
			(fetch: FetchFunction) =>
				streamGoogleGenerativeAI(createModel("google-generative-ai"), context, {
					apiKey: "test-key",
					fetch,
				}).result(),
			(fetch: FetchFunction) =>
				streamGoogleVertex(createModel("google-vertex"), context, { apiKey: "test-key", fetch }).result(),
		]) {
			const { bodies, message } = await run(start);
			expect(bodies).toHaveLength(2);
			expect(bodies[0]!.continuationToken).toBeUndefined();
			expect(bodies[1]!.continuationToken).toBe("token-1");
			expect(message.stopReason).toBe("stop");
			expect(message.content).toEqual([{ type: "text", text: "part two" }]);
			// Each hop bills its prompt, which includes the earlier output; the context holds the
			// first prompt plus all output.
			expect(message.usage).toMatchObject({ input: 25, output: 8, totalTokens: 18 });
		}
	});
});
