import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { XAI_MODELS } from "../src/providers/xai.models.ts";
import { xaiProvider } from "../src/providers/xai.ts";
import type { Context, Model } from "../src/types.ts";

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_xai_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequest(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions,
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		captured = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
		};
		return completedResponse();
	});

	const result = await xaiProvider().stream(model, context, options).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(captured).toBeDefined();
	return captured!;
}

describe("xAI Responses provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("excludes retired and redundant models from the built-in catalog", () => {
		for (const modelId of [
			"grok-3",
			"grok-3-fast",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-0309-reasoning",
			"grok-code-fast-1",
		]) {
			expect(Object.keys(XAI_MODELS)).not.toContain(modelId);
		}
	});

	it("uses Responses with low/medium/high efforts only for Grok 4.5", () => {
		expect(XAI_MODELS["grok-4.5"].api).toBe("openai-responses");
		expect(getSupportedThinkingLevels(XAI_MODELS["grok-4.5"])).toEqual(["low", "medium", "high"]);
		expect(XAI_MODELS["grok-4.3"].api).toBe("openai-completions");
	});

	it("uses /responses with bearer auth and xAI-compatible request fields", async () => {
		const captured = await captureRequest(
			XAI_MODELS["grok-4.5"],
			{
				systemPrompt: "You are a careful coding assistant.",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "xai-test-token",
				sessionId: "pi-session-123",
				cacheRetention: "long",
				reasoningEffort: "medium",
			},
		);

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.headers.get("authorization")).toBe("Bearer xai-test-token");
		expect(captured.headers.get("session_id")).toBe("pi-session-123");
		expect(captured.body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			prompt_cache_key: "pi-session-123",
			reasoning: { effort: "medium" },
			include: ["reasoning.encrypted_content"],
		});
		expect(captured.body).not.toHaveProperty("prompt_cache_retention");
		expect(captured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "developer",
					content: "You are a careful coding assistant.",
				}),
			]),
		);
	});
});
