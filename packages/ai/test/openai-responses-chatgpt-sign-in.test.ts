import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

async function capturePayload(
	apiKey: string,
	requestModel: Model<"openai-responses"> = model,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await streamOpenAIResponses(requestModel, context, {
		apiKey,
		maxTokens: 1000,
		temperature: 0.5,
		cacheRetention: "long",
		onPayload: (params) => {
			payload = params as Record<string, unknown>;
		},
		fetch: async () => new Response(null, { status: 500 }),
	}).result();
	if (!payload) throw new Error("Request payload was not captured");
	return payload;
}

describe("OpenAI Responses with Sign in with ChatGPT", () => {
	it("omits request fields that token sharing rejects", async () => {
		const payload = await capturePayload("chatgpt-access-token");

		expect(payload).not.toHaveProperty("max_output_tokens");
		expect(payload).not.toHaveProperty("temperature");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("omits prompt_cache_options on models with explicit prompt cache mode", async () => {
		const explicitCacheModel = { ...model, compat: { supportsExplicitPromptCacheMode: true } };

		const signInPayload = await capturePayload("chatgpt-access-token", explicitCacheModel);
		const apiKeyPayload = await capturePayload("sk-proj-test", explicitCacheModel);

		expect(signInPayload.prompt_cache_options).toBeUndefined();
		expect(apiKeyPayload.prompt_cache_options).toEqual({ ttl: "30m" });
	});

	it.each([
		{ name: "OpenAI API keys", apiKey: "sk-proj-test", requestModel: model },
		{
			name: "other OpenAI-compatible endpoints",
			apiKey: "gateway-key",
			requestModel: { ...model, baseUrl: "https://gateway.example.com/v1" },
		},
	])("keeps those fields for $name", async ({ apiKey, requestModel }) => {
		const payload = await capturePayload(apiKey, requestModel);

		expect(payload.max_output_tokens).toBe(1000);
		expect(payload.temperature).toBe(0.5);
		expect(payload.prompt_cache_retention).toBe("24h");
	});
});
