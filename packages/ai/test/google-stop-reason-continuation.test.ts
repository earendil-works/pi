import { FinishReason } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { mapStopReason } from "../src/api/google-shared.ts";
import { streamSimple as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinModels } from "../src/providers/all.ts";
import { googleProvider } from "../src/providers/google.ts";
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

	it.each(["gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen"])(
		"defaults %s on google and google-vertex to a 131072 whole-turn budget across mid-session hops",
		async (modelId) => {
			const models = builtinModels();
			const googleModel = models.getModel("google", modelId)!;
			const vertexModel = models.getModel("google-vertex", modelId)!;
			expect(googleModel).toMatchObject({ contextWindow: 1_048_576, maxTokens: 131_072 });
			expect(vertexModel).toMatchObject({ contextWindow: 1_048_576, maxTokens: 131_072 });

			// ~98k-token mid-session context: default maxOutputTokens must still stay at 131072 (> 65536).
			const midSessionContext = normalizeContext({
				messages: [{ role: "user", content: "x".repeat(98_353 * 4), timestamp: 1 }],
			});
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
								content: { role: "model", parts: [{ text: "delta epsilon" }] },
								finishReason: "CONTINUATION",
								continuationToken: "tok-mid-session",
							},
						],
						usageMetadata: { promptTokenCount: 98_353, candidatesTokenCount: 65_209, totalTokenCount: 163_562 },
					}),
					sse({
						candidates: [{ content: { role: "model", parts: [{ text: " zeta eta" }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 163_562, candidatesTokenCount: 4_791, totalTokenCount: 168_353 },
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
					models.streamSimple(googleModel, midSessionContext, { apiKey: "test-key", fetch }).result(),
				(fetch: FetchFunction) =>
					models
						.streamSimple(vertexModel, midSessionContext, {
							apiKey: "test-key",
							env: { GOOGLE_CLOUD_LOCATION: "us-central1" },
							fetch,
						})
						.result(),
			]) {
				const { bodies, message } = await run(start);
				expect(bodies).toHaveLength(2);
				const genCfg0 = bodies[0]!.generationConfig as Record<string, unknown> | undefined;
				const genCfg1 = bodies[1]!.generationConfig as Record<string, unknown> | undefined;
				expect(genCfg0?.maxOutputTokens).toBe(131_072);
				expect(bodies[0]!.continuationToken).toBeUndefined();
				expect(bodies[1]!.continuationToken).toBe("tok-mid-session");
				expect(genCfg1?.maxOutputTokens).toBe(131_072);
				expect(bodies[1]!.contents).toEqual(bodies[0]!.contents);
				expect(message.stopReason).toBe("stop");
				expect(message.content).toEqual([{ type: "text", text: "delta epsilon zeta eta" }]);
				expect(message.usage).toMatchObject({ input: 261_915, output: 70_000, totalTokens: 168_353 });
			}
		},
	);
});

describe("Google malformed generations", () => {
	it("maps MALFORMED_RESPONSE and unknown finish reasons to error instead of throwing", () => {
		expect(mapStopReason("MALFORMED_RESPONSE" as FinishReason)).toBe("error");
		expect(mapStopReason("SOME_FUTURE_REASON" as FinishReason)).toBe("error");
	});

	it.each(["MALFORMED_RESPONSE", "MALFORMED_FUNCTION_CALL"])("words %s so the agent retries it", async (finish) => {
		const sse = () =>
			new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: finish }] })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		const google = await streamGoogleGenerativeAI(createModel("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch: async () => sse(),
		}).result();
		const vertex = await streamGoogleVertex(createModel("google-vertex"), context, {
			apiKey: "test-key",
			fetch: async () => sse(),
		}).result();
		expect(google.stopReason).toBe("error");
		expect(google.errorMessage).toContain(`ended without a valid function call (${finish})`);
		expect(vertex.stopReason).toBe("error");
		expect(vertex.errorMessage).toContain(`ended without a valid function call (${finish})`);
	});
});

describe("Google live v1beta/models catalog refresh", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("discovers live v1beta/models drops, keeps baseline 131072 budgets over 32768 API limits, and upgrades stale pi.dev store entries", async () => {
		const provider = googleProvider();
		expect(provider.refreshModels).toBeTypeOf("function");

		const credentials = new InMemoryCredentialStore();
		await credentials.modify("google", async () => ({ type: "api_key", key: "test-gemini-key" }));
		const modelsStore = new InMemoryModelsStore();
		const baseHydrogen = provider.getModels().find((m) => m.id === "gemini-4-hydrogen")!;
		// Simulate an older persisted pi.dev overlay with 32k/65k caps and a 131k contextWindow.
		await modelsStore.write("google", {
			models: [{ ...baseHydrogen, contextWindow: 131_072, maxTokens: 65_536 }],
			checkedAt: Date.now(),
			lastModified: Date.now(),
			etag: '"stale-pidev-etag"',
		});

		const models = createModels({ credentials, modelsStore });
		models.setProvider(provider);

		// Offline cache restore immediately upgrades stale store limits to baseline.
		await models.refresh({ allowNetwork: false });
		expect(models.getModel("google", "gemini-4-hydrogen")).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		});

		// Online refresh hits v1beta/models (bypassing stale pi.dev etag), discovers new models,
		// skips TTS/music/image-only generators, and never downgrades Gemini 4 131072 budgets.
		const seenUrls: string[] = [];
		vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
			seenUrls.push(String(url));
			expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-gemini-key");
			return Response.json({
				models: [
					{
						name: "models/gemini-4-argon",
						displayName: "Gemini 4 Argon",
						inputTokenLimit: 1_048_576,
						outputTokenLimit: 32_768,
						thinking: true,
						supportedGenerationMethods: ["generateContent", "countTokens"],
					},
					{
						name: "models/gemini-3.9-flash",
						displayName: "Gemini 3.9 Flash",
						inputTokenLimit: 131_072,
						outputTokenLimit: 65_536,
						thinking: true,
						supportedGenerationMethods: ["generateContent", "countTokens"],
					},
					{
						name: "models/gemini-4-experimental",
						displayName: "Gemini 4 Experimental",
						inputTokenLimit: 1_048_576,
						outputTokenLimit: 32_768,
						thinking: true,
						supportedGenerationMethods: ["generateContent"],
					},
					{
						name: "models/gemini-3.8-flash-tts",
						displayName: "Gemini 3.8 Flash TTS",
						inputTokenLimit: 8_192,
						outputTokenLimit: 16_384,
						supportedGenerationMethods: ["generateContent"],
					},
					{
						name: "models/gemini-omni-1.2-flash",
						displayName: "Gemini Omni 1.2 Flash",
						inputTokenLimit: 131_072,
						outputTokenLimit: 65_536,
						supportedGenerationMethods: ["generateContent"],
					},
					{
						name: "models/lyria-3.5",
						displayName: "Lyria 3.5",
						inputTokenLimit: 1_048_576,
						outputTokenLimit: 65_536,
						supportedGenerationMethods: ["generateContent"],
					},
				],
			});
		});

		await models.refresh({ allowNetwork: true });
		expect(seenUrls).toEqual(["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"]);
		expect(models.getModel("google", "gemini-4-argon")).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 2, output: 10 },
		});
		expect(models.getModel("google", "gemini-3.9-flash")).toMatchObject({
			name: "Gemini 3.9 Flash",
			contextWindow: 131_072,
			maxTokens: 65_536,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(models.getModel("google", "gemini-4-experimental")).toMatchObject({
			name: "Gemini 4 Experimental",
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			reasoning: true,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		});
		expect(models.getModel("google", "gemini-3.8-flash-tts")).toBeUndefined();
		expect(models.getModel("google", "gemini-omni-1.2-flash")).toBeUndefined();
		expect(models.getModel("google", "lyria-3.5")).toBeUndefined();
	});
});
