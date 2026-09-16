import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Context, Model, OpenAIResponsesCompat } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function createModel(promptCacheKeyMode?: OpenAIResponsesCompat["promptCacheKeyMode"]): Model<"openai-responses"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "test-proxy",
		baseUrl: "https://proxy.example.com/v1",
		compat: { promptCacheKeyMode },
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

async function capturePayload(
	promptCacheKeyMode?: OpenAIResponsesCompat["promptCacheKeyMode"],
	cacheRetention?: "none" | "short" | "long",
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string | URL, init?: RequestInit) => {
			payload = JSON.parse(String(init?.body));
			return new Response(
				'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}),
	);

	await stream(createModel(promptCacheKeyMode), context, {
		apiKey: "test-key",
		sessionId: "session-123",
		cacheRetention,
	}).result();

	if (!payload) throw new Error("Expected request payload");
	return payload;
}

describe("OpenAI Responses prompt cache key policy", () => {
	it("preserves the existing default behavior", async () => {
		expect((await capturePayload()).prompt_cache_key).toBe("session-123");
	});

	it("emits the key when enabled", async () => {
		expect((await capturePayload("enabled")).prompt_cache_key).toBe("session-123");
	});

	it("omits the key when disabled", async () => {
		expect((await capturePayload("disabled")).prompt_cache_key).toBeUndefined();
	});

	it("lets cacheRetention none override enabled mode", async () => {
		expect((await capturePayload("enabled", "none")).prompt_cache_key).toBeUndefined();
	});
});
